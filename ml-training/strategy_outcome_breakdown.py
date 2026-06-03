#!/usr/bin/env python3
"""Are 8/12 ATR targets realistic, or is the EV an artifact of the 72h mark-to-market exit?
For tail-gated trades (SL=1 ATR), tabulate HOW trades exit: hit target / stopped / timed-out,
and the avg R of each. Also report the real distribution of 72h favorable excursion in ATR,
and what an ATR is in % terms — so we know if these targets are once-in-two-years or routine.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = 18
FEE, SLIP, FUND = 0.07, 0.03, 0.03   # Binance USDT realistic ~0.13%
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('open', 'high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def trade(direction, entry, atr, sl_atr, tp_atr, h, l, c):
    """Returns (R, exit_reason, max_fav_atr_reached)."""
    sl = entry - sl_atr * atr if direction == 1 else entry + sl_atr * atr
    tp = entry + tp_atr * atr if direction == 1 else entry - tp_atr * atr
    cost = (FEE + SLIP + FUND) / 100 * entry / (sl_atr * atr)
    maxfav = 0.0
    for j in range(min(HOLD, len(h))):
        fav = (h[j] - entry) / atr if direction == 1 else (entry - l[j]) / atr
        maxfav = max(maxfav, fav)
        sh, th = (l[j] <= sl, h[j] >= tp) if direction == 1 else (h[j] >= sl, l[j] <= tp)
        if th: return tp_atr / sl_atr - cost, 'target', maxfav
        if sh: return -1.0 - cost, 'stop', maxfav
    move = (c[min(HOLD, len(c)) - 1] - entry) * direction
    return float(np.clip(move / (sl_atr * atr), -1.0, tp_atr / sl_atr)) - cost, 'timeout', maxfav


def main():
    df = ev.load_features('csv_exports_v11_fixed'); df = P1.add_labels(df)
    df = df[df['fwdReturn24H'].notna() & df['fwdMaxFavR72H'].notna()].copy()
    df['bigTail'] = (df['fwdMaxFavR72H'] >= 5).astype(int)
    df = df.sort_values('timestamp').reset_index(drop=True)
    print(f"atrPercent (the ATR unit): median={df['atrPercent'].median():.2f}% "
          f"p25={df['atrPercent'].quantile(.25):.2f}% p75={df['atrPercent'].quantile(.75):.2f}%")
    med = df['atrPercent'].median()
    print(f"  → in price terms a 3/5/8/12 ATR move ≈ {3*med:.0f}% / {5*med:.0f}% / {8*med:.0f}% / {12*med:.0f}%\n")

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
    print(f"tail-gated trades: {len(rows):,}  | SL=1 ATR, 72h hold, Binance ~0.13% fees\n")

    # distribution of 72h favorable excursion actually reached (best side), ignoring stops
    bestfav = []
    for en, a, h, l, c in rows:
        _, _, fu = trade(1, en, a, 1.0, 99, h, l, c); _, _, fd = trade(-1, en, a, 1.0, 99, h, l, c)
        bestfav.append(max(fu, fd))
    bestfav = np.array(bestfav)
    print("72h favorable excursion REACHED (best of the two sides), ignoring the stop:")
    for k in [3, 5, 8, 12]:
        print(f"   >= {k:>2} ATR (~{k*med:.0f}% move): {(bestfav >= k).mean()*100:4.0f}% of signals")

    print("\nHow trades EXIT (avg of long & short side), SL=1 ATR:")
    print(f"  {'target':>7}{'%hit':>8}{'%stop':>8}{'%timeout':>10}{'avgR|timeout':>14}{'mean R/trade':>14}")
    for tp in [5.0, 8.0, 12.0]:
        reasons = {'target': [], 'stop': [], 'timeout': []}; allr = []
        for en, a, h, l, c in rows:
            for d in (1, -1):
                r, why, _ = trade(d, en, a, 1.0, tp, h, l, c); reasons[why].append(r); allr.append(r)
        n = len(allr)
        print(f"  {tp:>6.0f}A{len(reasons['target'])/n*100:>7.0f}%{len(reasons['stop'])/n*100:>7.0f}%"
              f"{len(reasons['timeout'])/n*100:>9.0f}%{np.mean(reasons['timeout']):>+14.3f}{np.mean(allr):>+14.3f}")
    print("\n→ if %hit is tiny and the EV rides on 'avgR|timeout', the wide target is just an UPSIDE CAP, "
          "not a level you reach — the real exit is the 72h mark-to-market.")


if __name__ == '__main__':
    main()
