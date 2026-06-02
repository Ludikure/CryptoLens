#!/usr/bin/env python3
"""
Can AI predict the TAIL (not the body) and use it to select profitable convex trades?
  - ML_WIN target = goodR (>=1.5 ATR move) — the BODY. Predicts volatility, hurts the convex trade.
  - TAIL target   = fwdMaxFavR72H >= 5 ATR  — the big runs the convex trade lives on.
Train both on clean data (csv_exports_v11_fixed), WF. Test: does TAIL-gating make the
let-winners-run strategy (1R stop / 5R target / 72h) beat ungated baseline AFTER costs?
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
TP_ATR, SL_ATR, HOLD = 5.0, 1.0, 18
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.12,0.06,0.03').split(',')]
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trade(direction, entry, atr, o, h, l, c):
    sl = entry - SL_ATR * atr if direction == 1 else entry + SL_ATR * atr
    tp = entry + TP_ATR * atr if direction == 1 else entry - TP_ATR * atr
    cost = (FEE + SLIP + FUND) / 100 * entry / (SL_ATR * atr)
    for j in range(min(HOLD, len(h))):
        sh, th = (l[j] <= sl, h[j] >= tp) if direction == 1 else (h[j] >= sl, l[j] <= tp)
        if th: return TP_ATR / SL_ATR - cost
        if sh: return -1.0 - cost
    move = (c[min(HOLD, len(c)) - 1] - entry) * direction
    return float(np.clip(move / (SL_ATR * atr), -1.0, TP_ATR / SL_ATR)) - cost


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    print(f"rows={len(df):,}  bigTail base rate={df['bigTail'].mean()*100:.0f}%  | convex 1R/{TP_ATR:.0f}R, 72h, costs~{FEE+SLIP+FUND:.2f}%\n")
    res = {'base': [], 'ml': [], 'tail': []}; tailtb = []
    for k in range(len(edges) - 1):
        wlo, whi = edges[k], edges[k + 1]
        tr = df[df['timestamp'] < wlo - 14 * 86400]; te = df[(df['timestamp'] >= wlo) & (df['timestamp'] < whi)].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mq = H.make_model(); mq.fit(tr[H.FEATURES].fillna(0), tr['goodR'])
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['mlP'] = mq.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        # does the tail model discriminate? realized bigTail rate in its top decile
        thr = te['tailP'].quantile(0.90)
        tailtb.append(te[te['tailP'] >= thr]['bigTail'].mean() * 100)
        for _, row in te.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
            if s >= len(ct) or s == 0: continue
            e = min(s + HOLD, len(ct)); o, h, l, c = (cidx[sym][q][s:e] for q in ('open', 'high', 'low', 'close'))
            if len(h) < 2: continue
            entry = cidx[sym]['close'][s - 1]; atr = row['atrPercent'] / 100 * entry
            r = (trade(1, entry, atr, o, h, l, c) + trade(-1, entry, atr, o, h, l, c)) / 2
            res['base'].append(r)
            if row['mlP'] >= 0.70: res['ml'].append(r)
            if row['tailP'] >= thr: res['tail'].append(r)
    a = {k: np.array(v) for k, v in res.items()}
    print("=== POOLED ===")
    print(f"  TAIL model top-decile realized bigTail rate: {np.mean(tailtb):.0f}%  (base {df['bigTail'].mean()*100:.0f}%) "
          f"— {'predicts tails' if np.mean(tailtb) > df['bigTail'].mean()*100+5 else 'NO tail signal'}")
    for k, lab in [('base', 'baseline (all bars)'), ('ml', 'ML_WIN-gated (body)'), ('tail', 'TAIL-gated')]:
        v = a[k]
        print(f"  convex netR/trade  {lab:<22} {v.mean():>+6.3f}  win={ (v>0).mean()*100:>4.0f}%  n={len(v):>7,}")
    print(f"\n  → TAIL gating {'PROFITABLE' if a['tail'].mean()>0 else 'unprofitable'} after costs; "
          f"{'BEATS' if a['tail'].mean()>a['base'].mean() else 'does NOT beat'} baseline")


if __name__ == '__main__':
    main()
