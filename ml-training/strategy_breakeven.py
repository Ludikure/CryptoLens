#!/usr/bin/env python3
"""
Break-even fee analysis for the tail-gated convex crypto strategy (1R stop / 5R target / 72h).

The strategy's edge is +EV GROSS but the sign depends entirely on round-trip cost. This models the
FULL cost-sensitivity curve from ONE walk-forward training pass: the per-trade cost is linear in the
round-trip %, so net_R(c) = mean(grossR_i) - c * mean(k_i), where k_i = entry / (SL_ATR*atr) / 100 is
the per-trade cost multiplier (cost in R units per 1% of round-trip cost). Break-even c* = mean_gross / mean_k.

Prints net R/trade across a cost sweep so we can map real venues/tiers against break-even.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
TP_ATR, SL_ATR, HOLD = 5.0, 1.0, 18
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def gross_trade(direction, entry, atr, o, h, l, c):
    """Gross R (no cost) + the per-trade cost multiplier k = entry/(SL_ATR*atr)/100."""
    sl = entry - SL_ATR * atr if direction == 1 else entry + SL_ATR * atr
    tp = entry + TP_ATR * atr if direction == 1 else entry - TP_ATR * atr
    k = entry / (SL_ATR * atr) / 100.0
    for j in range(min(HOLD, len(h))):
        sh, th = (l[j] <= sl, h[j] >= tp) if direction == 1 else (h[j] >= sl, l[j] <= tp)
        if th: return TP_ATR / SL_ATR, k
        if sh: return -1.0, k
    move = (c[min(HOLD, len(c)) - 1] - entry) * direction
    return float(np.clip(move / (SL_ATR * atr), -1.0, TP_ATR / SL_ATR)), k


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)

    gross, kmult = [], []          # tail-gated trades: gross R and cost multiplier
    for kf in range(len(edges) - 1):
        wlo, whi = edges[kf], edges[kf + 1]
        tr = df[df['timestamp'] < wlo - 14 * 86400]; te = df[(df['timestamp'] >= wlo) & (df['timestamp'] < whi)].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        thr = te['tailP'].quantile(0.90)                       # top-decile tail conviction = the convex entries
        sel = te[(te['tailP'] >= thr) & (te['tradeDir'] != 0)]
        for _, row in sel.iterrows():
            sym = row['symbol']
            if sym not in cidx or row['atrPercent'] <= 0: continue
            ci = cidx[sym]; pos = np.searchsorted(ci['t'], int(row['timestamp']))
            if pos + 1 >= len(ci['t']): continue
            entry = ci['open'][pos + 1]; atr = row['atrPercent'] / 100.0 * entry
            if atr <= 0: continue
            g, k = gross_trade(int(row['tradeDir']), entry, atr,
                               ci['open'][pos + 1:], ci['high'][pos + 1:], ci['low'][pos + 1:], ci['close'][pos + 1:])
            gross.append(g); kmult.append(k)

    gross = np.array(gross); kmult = np.array(kmult)
    n = len(gross); mg = gross.mean(); mk = kmult.mean()
    winr = (gross >= TP_ATR / SL_ATR - 1e-9).mean()
    breakeven = mg / mk
    print(f"\ntail-gated convex trades: n={n:,}  win rate(5R)={winr*100:.1f}%")
    print(f"GROSS EV = {mg:+.3f} R/trade   |   mean cost multiplier k = {mk:.3f} R per 1% round-trip")
    print(f"BREAK-EVEN round-trip cost = {breakeven:.3f}%\n")
    print(f"{'round-trip %':>13} | {'net R/trade':>11} | verdict")
    print('-' * 42)
    for c in [0.00, 0.05, 0.08, 0.10, 0.12, breakeven, 0.15, 0.18, 0.20, 0.25, 0.30]:
        net = mg - c * mk
        tag = '  <-- BREAK-EVEN' if abs(c - breakeven) < 1e-9 else ('  +EV' if net > 0 else '  -EV')
        print(f"{c:>12.3f}% | {net:>+10.3f} |{tag}")


if __name__ == '__main__':
    main()
