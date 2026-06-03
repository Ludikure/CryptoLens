#!/usr/bin/env python3
"""Does a WIDER stop fix the wick-out problem? Sweep (stop, target) in ATR on the
tail-gated convex strategy, clean data, real bar-by-bar fills, at the user's Coinbase fees.
Net R/trade is comparable across stop widths because cost_R = cost% / (SL_ATR*atr%) and you
size to the stop (constant $ risk) — so R is always "risk units," and cost shrinks as SL grows.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = 18
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.20,0.05,0.03').split(',')]  # ~0.28% taker
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
SLS = [1.0, 1.5, 2.0, 2.5, 3.0]
TPS = [3.0, 5.0, 8.0, 12.0]


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trade(direction, entry, atr, sl_atr, tp_atr, h, l, c):
    sl = entry - sl_atr * atr if direction == 1 else entry + sl_atr * atr
    tp = entry + tp_atr * atr if direction == 1 else entry - tp_atr * atr
    cost = (FEE + SLIP + FUND) / 100 * entry / (sl_atr * atr)
    for j in range(min(HOLD, len(h))):
        sh, th = (l[j] <= sl, h[j] >= tp) if direction == 1 else (h[j] >= sl, l[j] <= tp)
        if th: return tp_atr / sl_atr - cost
        if sh: return -1.0 - cost
    move = (c[min(HOLD, len(c)) - 1] - entry) * direction
    return float(np.clip(move / (sl_atr * atr), -1.0, tp_atr / sl_atr)) - cost


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna() & df['fwdMaxUp24H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)

    # how fast does whipsaw (both sides wicked) drop as the stop widens?
    up, dn = df['fwdMaxUp24H'], df['fwdMaxDown24H']
    print(f"whipsaw — P(price moves >= k ATR in BOTH directions in 24h):")
    for k in [1.0, 1.5, 2.0, 2.5, 3.0]:
        print(f"   stop {k:.1f} ATR: {((up >= k) & (dn >= k)).mean()*100:4.0f}%   "
              f"(one-side stop P: {((up >= k) | (dn >= k)).mean()*100:.0f}%)")

    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    # WF: train tail model once, collect tail-gated test bars
    gated = []
    for k in range(len(edges) - 1):
        tr = df[df['timestamp'] < edges[k] - 14 * 86400]; te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        gated.append(te[te['tailP'] >= te['tailP'].quantile(0.90)])
    g = pd.concat(gated, ignore_index=True)
    # pre-resolve candle windows once per gated bar
    rows = []
    for _, row in g.iterrows():
        sym = row['symbol']
        if sym not in cidx or row['atrPercent'] <= 0: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
        if s >= len(ct) or s == 0: continue
        e = min(s + HOLD, len(ct)); h, l, c = (cidx[sym][q][s:e] for q in ('high', 'low', 'close'))
        if len(h) < 2: continue
        rows.append((cidx[sym]['close'][s - 1], row['atrPercent'] / 100 * cidx[sym]['close'][s - 1], h, l, c))
    print(f"\ntail-gated bars: {len(rows):,}  | costs ~{FEE+SLIP+FUND:.2f}% (your Coinbase fees), 72h hold")
    print(f"net R/trade (constant-$-risk units):\n")
    print("  stop\\tgt " + "".join(f"{f'{tp:.0f}ATR':>9}" for tp in TPS))
    best = (None, -9)
    for sl in SLS:
        cells = []
        for tp in TPS:
            rs = [(trade(1, en, a, sl, tp, h, l, c) + trade(-1, en, a, sl, tp, h, l, c)) / 2 for en, a, h, l, c in rows]
            m = float(np.mean(rs)); cells.append(m)
            if m > best[1]: best = ((sl, tp), m)
        print(f"  {sl:.1f} ATR  " + "".join(f"{v:>+9.3f}" for v in cells))
    print(f"\n  best: stop {best[0][0]:.1f} / target {best[0][1]:.0f} ATR  →  {best[1]:+.3f} R/trade  "
          f"({'PROFITABLE' if best[1] > 0 else 'still negative'} after your fees)")


if __name__ == '__main__':
    main()
