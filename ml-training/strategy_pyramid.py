#!/usr/bin/env python3
"""Measures the remaining ideas from the investigation list:
 1. PYRAMIDING — add a unit each +K ATR of confirmed favorable progress, common trailing stop.
    Distinct from re-entry: bets on CONTINUATION of a winner, not recovery after a loss.
 2. BREAKOUT-RESET re-entry — after a stop, only re-enter if price breaks the prior favorable
    extreme by +0.5 ATR (confirmation filter) vs immediate re-entry.
 Both vs the single-shot trailing baseline (+0.060). Tail-gated, Binance fees, clean data.
 Prediction from barrier-ordering: continuation/breakout are still random ordering -> shouldn't help.
"""
import os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
H = __import__('_harness'); P1 = __import__('phase1_meta'); ev = __import__('edge_validation')
HOLD = int(os.environ.get('HOLD', 30)); TRAIL = 2.0
FEE, SLIP, FUND = [float(x) for x in os.environ.get('COSTS', '0.07,0.03,0.03').split(',')]
CANDLES = os.path.join(os.path.dirname(__file__), 'crypto_candles_4h.csv.gz')


def candle_index():
    c = pd.read_csv(CANDLES); tc = 'time' if 'time' in c.columns else 'timestamp'
    t = c[tc].values.astype(np.int64); t = t // 1000 if t.max() > 1e12 else t
    c['t'] = t; idx = {}
    for sym, g in c.sort_values('t').groupby('symbol'):
        idx[sym] = {k: g[k].values.astype(float) for k in ('high', 'low', 'close')}; idx[sym]['t'] = g['t'].values.astype(np.int64)
    return idx


def pyramid_R(direction, en, atr, h, l, c, add_K, max_adds):
    R = atr; cpu = (FEE + SLIP + FUND) / 100 * en / R
    n = min(HOLD, len(h)); units = [en]; ext = en
    stop = en - R if direction == 1 else en + R
    nxt = en + add_K * atr if direction == 1 else en - add_K * atr
    for j in range(n):
        if (direction == 1 and l[j] <= stop) or (direction == -1 and h[j] >= stop):
            return sum((stop - u) * direction / R for u in units) - cpu * len(units)
        fav = h[j] if direction == 1 else l[j]
        ext = max(ext, fav) if direction == 1 else min(ext, fav)
        while len(units) < 1 + max_adds and ((direction == 1 and ext >= nxt) or (direction == -1 and ext <= nxt)):
            units.append(nxt); nxt = nxt + add_K * atr if direction == 1 else nxt - add_K * atr
        stop = max(stop, ext - TRAIL * atr) if direction == 1 else min(stop, ext + TRAIL * atr)
    return sum((c[n - 1] - u) * direction / R for u in units) - cpu * len(units)


def reentry_R(direction, en, atr, h, l, c, max_re, breakout):
    """trailing with re-entry after a losing stop; breakout=True requires +0.5ATR break of prior high."""
    R = atr; cpu = (FEE + SLIP + FUND) / 100 * en / R
    n = min(HOLD, len(h)); total = 0.0; entry = en; j = 0; legs = 0
    while legs <= max_re and j < n:
        stop = entry - R if direction == 1 else entry + R; ext = entry; out = None
        while j < n:
            if direction == 1 and l[j] <= stop: out = (stop - entry) / R; break
            if direction == -1 and h[j] >= stop: out = (entry - stop) / R; break
            ext = max(ext, h[j]) if direction == 1 else min(ext, l[j])
            stop = max(stop, ext - TRAIL * atr) if direction == 1 else min(stop, ext + TRAIL * atr)
            j += 1
        if out is None:
            total += (c[n - 1] - entry) * direction / R - cpu; break
        total += out - cpu; legs += 1
        if out > 0 or j >= n: break
        if breakout:  # wait for price to break the stop bar's level by +0.5 ATR before re-entry
            trig = c[j] + 0.5 * atr if direction == 1 else c[j] - 0.5 * atr; k = j + 1
            while k < n and ((direction == 1 and h[k] < trig) or (direction == -1 and l[k] > trig)): k += 1
            if k >= n: break
            entry = trig; j = k + 1
        else:
            entry = c[j]; j += 1
    return total


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
    g = pd.concat(gated, ignore_index=True); rows = []
    for _, row in g.iterrows():
        sym = row['symbol']
        if sym not in cidx or row['atrPercent'] <= 0: continue
        ct = cidx[sym]['t']; s = np.searchsorted(ct, int(row['timestamp']), 'right')
        if s >= len(ct) or s == 0: continue
        e = min(s + HOLD, len(ct)); h, l, c = cidx[sym]['high'][s:e], cidx[sym]['low'][s:e], cidx[sym]['close'][s:e]
        if len(h) < 2: continue
        en = cidx[sym]['close'][s - 1]; rows.append((en, row['atrPercent'] / 100 * en, h, l, c))
    avg = lambda f: float(np.mean([(f(1, en, a, h, l, c) + f(-1, en, a, h, l, c)) / 2 for en, a, h, l, c in rows]))
    print(f"tail-gated {len(rows):,}, trail {TRAIL} ATR, Binance ~{FEE+SLIP+FUND:.2f}%  (single-shot baseline = +0.060)\n")
    base = avg(lambda d, en, a, h, l, c: reentry_R(d, en, a, h, l, c, 0, False))
    print(f"  {'single-shot trailing':<34}{base:>+8.3f}")
    print("  --- PYRAMIDING (add to confirmed winners) ---")
    for K, ma in [(1.5, 1), (1.5, 2), (2.0, 2), (2.0, 3)]:
        m = avg(lambda d, en, a, h, l, c, K=K, ma=ma: pyramid_R(d, en, a, h, l, c, K, ma))
        print(f"  {f'add every {K} ATR, max {ma} adds':<34}{m:>+8.3f}{(m-base)*1000:>+7.0f}m")
    print("  --- BREAKOUT-RESET re-entry (confirm before re-entry) ---")
    for mr in [1, 2]:
        m = avg(lambda d, en, a, h, l, c, mr=mr: reentry_R(d, en, a, h, l, c, mr, True))
        print(f"  {f'breakout re-entry, max {mr}':<34}{m:>+8.3f}{(m-base)*1000:>+7.0f}m")
    print("\n→ if every variant <= baseline, the single-shot convex trade already extracts all the "
          "harvestable variance; the rest just add cost-laden random-ordered bets.")


if __name__ == '__main__':
    main()
