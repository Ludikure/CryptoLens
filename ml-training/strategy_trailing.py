#!/usr/bin/env python3
"""Does the edge survive a REAL trailing-stop exit (vs the idealized 72h mark-to-market)?
Enter at market, initial stop 1 ATR. Each bar: (conservative) check the stop against the bar's
adverse extreme FIRST using last bar's stop, then ratchet the stop to (favorable high-water -
TRAIL ATR). Exit when the trail is hit; a long HOLD cap is only a backstop. Tail-gated, clean
data, Binance fees. If mean R stays ~+0.05 the strategy is real; if it collapses it was an
artifact of marking-to-market at an arbitrary hour.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = int(os.environ.get('HOLD', 30))          # 120h backstop (let trends breathe)
SL_ATR = 1.0
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.07,0.03,0.03').split(',')]  # Binance USDT ~0.13%
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')
TRAILS = [1.0, 1.5, 2.0, 2.5, 3.0]


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trade_trail(direction, entry, atr, trail_atr, h, l, c):
    """Returns (R, exit_reason). R unit = SL_ATR*atr initial risk."""
    R = SL_ATR * atr
    cost = (FEE + SLIP + FUND) / 100 * entry / R
    stop = entry - R if direction == 1 else entry + R
    ext = entry
    n = min(HOLD, len(h))
    for j in range(n):
        # conservative: adverse extreme hits the (pre-update) stop first
        if direction == 1 and l[j] <= stop:
            r = (stop - entry) / R - cost; return r, ('trailed' if stop > entry else 'stoploss')
        if direction == -1 and h[j] >= stop:
            r = (entry - stop) / R - cost; return r, ('trailed' if stop < entry else 'stoploss')
        # ratchet the trail behind the favorable high-water mark
        if direction == 1:
            ext = max(ext, h[j]); stop = max(stop, ext - trail_atr * atr)
        else:
            ext = min(ext, l[j]); stop = min(stop, ext + trail_atr * atr)
    exitp = c[n - 1]
    return (exitp - entry) * direction / R - cost, 'timecap'


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    cidx = candle_index()
    edges = np.linspace(df['timestamp'].min() + (df['timestamp'].max() - df['timestamp'].min()) * 0.35, df['timestamp'].max(), 6)
    gated = []
    for k in range(len(edges) - 1):
        tr = df[df['timestamp'] < edges[k] - 14 * 86400]; te = df[(df['timestamp'] >= edges[k]) & (df['timestamp'] < edges[k + 1])].copy()
        if len(tr) < 8000 or len(te) < 200: continue
        mt = H.make_model(); mt.fit(tr[H.FEATURES].fillna(0), tr['bigTail'])
        te['tailP'] = mt.predict_proba(te[H.FEATURES].fillna(0))[:, 1]
        gated.append(te[te['tailP'] >= te['tailP'].quantile(0.90)])
    g = pd.concat(gated, ignore_index=True)
    rows = []
    for _, row in g.iterrows():
        sym = row['symbol']
        if sym not in cidx or row['atrPercent'] <= 0: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
        if s >= len(ct) or s == 0: continue
        e = min(s + HOLD, len(ct)); h, l, c = (cidx[sym][q][s:e] for q in ('high', 'low', 'close'))
        if len(h) < 2: continue
        en = cidx[sym]['close'][s - 1]; rows.append((en, row['atrPercent'] / 100 * en, h, l, c))
    print(f"tail-gated trades: {len(rows):,}  | SL=1 ATR, trailing exit, {HOLD*4}h backstop, costs ~{FEE+SLIP+FUND:.2f}%\n")
    print(f"  {'trail':>6}{'mean R':>9}{'median R':>10}{'%win':>7}{'%stoploss':>11}{'%trailed':>10}{'%timecap':>10}{'avgR|win':>10}")
    best = (None, -9)
    for tr_atr in TRAILS:
        rs, why = [], []
        for en, a, h, l, c in rows:
            for d in (1, -1):
                r, w = trade_trail(d, en, a, tr_atr, h, l, c); rs.append(r); why.append(w)
        rs = np.array(rs); why = np.array(why); n = len(rs)
        wins = rs[rs > 0]
        print(f"  {tr_atr:>5.1f}A{rs.mean():>+9.3f}{np.median(rs):>+10.3f}{(rs>0).mean()*100:>6.0f}%"
              f"{(why=='stoploss').mean()*100:>10.0f}%{(why=='trailed').mean()*100:>9.0f}%"
              f"{(why=='timecap').mean()*100:>9.0f}%{(wins.mean() if len(wins) else 0):>+10.3f}")
        if rs.mean() > best[1]: best = (tr_atr, rs.mean())
    print(f"\n  best trail {best[0]:.1f} ATR → {best[1]:+.3f} R/trade "
          f"({'SURVIVES — real strategy' if best[1] > 0.02 else 'COLLAPSED — was a mark-to-market artifact' if best[1] < 0.01 else 'marginal'})")
    print(f"  (compare: idealized 72h mark-to-market gave +0.067 at SL1/TP12)")


if __name__ == '__main__':
    main()
