#!/usr/bin/env python3
"""
THE definitive clean-data test (csv_exports_v11_fixed, leak closed):
  1. Retrain ML_WIN on clean data — is the quality (volatility) edge real?
  2. Convex / let-winners-run strategy (direct entry, 1R stop, far target, direction-agnostic):
     does ML_WIN GATING beat the ungated baseline AFTER realistic costs? = "can AI select trades?"
Walk-forward, real bar-by-bar fills, real costs.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
TP_ATR = float(os.environ.get('TP', 5.0)); SL_ATR = 1.0; HOLD = 18
FEE = 0.12; SLIP = 0.06; FUND = 0.03            # round-trip ~0.21% of price
GATE = 0.70
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}
        idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trade(direction, entry, atr, o, h, l, c):
    sl = entry - SL_ATR * atr if direction == 1 else entry + SL_ATR * atr
    tp = entry + TP_ATR * atr if direction == 1 else entry - TP_ATR * atr
    cost = (FEE + SLIP + FUND) / 100 * entry / (SL_ATR * atr)
    for j in range(min(HOLD, len(h))):
        if direction == 1: sh, th = l[j] <= sl, h[j] >= tp
        else: sh, th = h[j] >= sl, l[j] <= tp
        if th: return TP_ATR / SL_ATR - cost
        if sh: return -1.0 - cost
    move = (c[min(HOLD, len(c)) - 1] - entry) * direction
    return float(np.clip(move / (SL_ATR * atr), -1.0, TP_ATR / SL_ATR)) - cost


def main():
    print("Loading CLEAN data (csv_exports_v11_fixed) + candles...")
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna()].copy(); df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    tlo, thi = df['timestamp'].min(), df['timestamp'].max()
    edges = np.linspace(tlo + (thi - tlo) * 0.35, thi, 6)
    print(f"rows={len(df):,}  | strategy: 1R stop / {TP_ATR:.0f}R target, costs ~{FEE+SLIP+FUND:.2f}%, gate ML>={GATE}\n")
    tb, gn, bn = [], [], []   # top-bucket goodR rates, gated net Rs, baseline net Rs
    for k in range(len(edges) - 1):
        wlo, whi = edges[k], edges[k + 1]
        tr = df[df['timestamp'] < wlo - 14 * 86400]
        te = df[(df['timestamp'] >= wlo) & (df['timestamp'] < whi)].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mq = H.make_model(); mq.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        te['mlP'] = mq.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        top = te[te['mlP'] >= GATE]; tbr = top['goodR'].mean() * 100 if len(top) else float('nan')
        base, gated = [], []
        for _, row in te.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + HOLD, len(ct)); o, h, l, c = (cidx[sym][q][s:e] for q in ('open', 'high', 'low', 'close'))
            if len(h) < 2: continue
            entry = cidx[sym]['close'][s - 1]; atr = row['atrPercent'] / 100 * entry
            r = (trade(1, entry, atr, o, h, l, c) + trade(-1, entry, atr, o, h, l, c)) / 2
            base.append(r)
            if row['mlP'] >= GATE: gated.append(r)
        base, gated = np.array(base), np.array(gated)
        d0 = pd.to_datetime(wlo, unit='s').date()
        print(f"fold {k+1} ({d0}): ML_WIN top-bucket goodR={tbr:>4.0f}% (base {te['goodR'].mean()*100:.0f}%) | "
              f"convex netR/trade  baseline={base.mean():>+6.3f}  ML-gated={gated.mean() if len(gated) else float('nan'):>+6.3f}")
        tb.append(tbr); bn += list(base); gn += list(gated)
    bn, gn = np.array(bn), np.array(gn)
    print(f"\n=== POOLED ===")
    print(f"  ML_WIN top-bucket goodR (clean): {np.nanmean(tb):.0f}%   [real if >> ~51% baseline]")
    print(f"  convex netR/trade  baseline (all bars): {bn.mean():>+6.3f}  (n={len(bn):,})")
    print(f"  convex netR/trade  ML_WIN-gated:        {gn.mean():>+6.3f}  (n={len(gn):,})")
    print(f"  → AI selection {'HELPS' if gn.mean() > bn.mean() else 'does NOT help'} "
          f"({(gn.mean()-bn.mean())*1000:+.0f} mR/trade vs ungated); "
          f"{'PROFITABLE' if gn.mean() > 0 else 'unprofitable'} after costs")


if __name__ == '__main__':
    main()
