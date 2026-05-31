#!/usr/bin/env python3
"""
Is VOLUME a real S/R strength signal — where test-count, flip, weekly, and Fib all failed?

Volume-at-level has the strongest mechanism of all the "strength" notions: a price where
lots of volume transacted is a price where lots of orders rested. Two flavors, both tested:

  (1) formation volume — volume on the swing-pivot bar vs its 20-bar average. High = the
      swing was made on conviction.
  (2) volume-at-price — cumulative volume traded THROUGH the level price over a 60-bar
      lookback / total window volume. High = a high-volume node (volume-profile concept).

Daily candles WITH volume (fetch_daily_volume.py). Swing levels detected on daily; each
graded HOLD/BREAK with the same forward-outcome logic (daily-tuned horizon). Levels ranked
into within-symbol terciles by each volume metric; hold rate compared low vs high tercile.
If high-volume levels hold meaningfully more, volume is the real strength metric.

Run (after fetch):  python3 volume_at_level.py
"""
import numpy as np
import pandas as pd

LV = __import__('level_validation')
LV.HORIZON = 10        # ~2 weeks on daily bars
LV.MAX_LEVEL_AGE = 40

DAILY = {'crypto': 'daily_candles_crypto.csv.gz', 'stock': 'daily_candles_stock.csv.gz'}
WINDOW = 60            # lookback bars for volume-at-price


def run(market, path):
    df = pd.read_csv(path)
    parts = []
    for sym, g in df.groupby('symbol'):
        g = g.sort_values('timestamp').reset_index(drop=True)
        if len(g) < 120:
            continue
        h = g['high'].values; l = g['low'].values; c = g['close'].values; v = g['volume'].values
        if np.nansum(v) <= 0:
            continue
        atr = LV.atr_series(h, l, c)
        per = []
        for pivot_idx, confirm_idx, price, is_high in LV.swings(h, l):
            if pivot_idx < 25 or atr[pivot_idx] <= 0:
                continue
            out = LV.forward_outcome(h, l, c, atr, confirm_idx, price, is_resistance=is_high)
            if out is None:
                continue
            held = out[0]
            # (1) formation volume ratio
            base = np.mean(v[pivot_idx - 20:pivot_idx])
            fvr = v[pivot_idx] / base if base > 0 else np.nan
            # (2) volume-at-price fraction over lookback
            lo = max(0, pivot_idx - WINDOW)
            hh = h[lo:pivot_idx]; ll = l[lo:pivot_idx]; vv = v[lo:pivot_idx]
            tot = vv.sum()
            vap = vv[(ll <= price) & (hh >= price)].sum() / tot if tot > 0 else np.nan
            per.append((held, fvr, vap))
        if len(per) >= 9:
            p = pd.DataFrame(per, columns=['held', 'fvr', 'vap']).dropna()
            if len(p) < 9:
                continue
            p['ft'] = pd.qcut(p['fvr'].rank(method='first'), 3, labels=['low', 'mid', 'high'])
            p['vt'] = pd.qcut(p['vap'].rank(method='first'), 3, labels=['low', 'mid', 'high'])
            parts.append(p)

    allp = pd.concat(parts, ignore_index=True)
    base = allp['held'].mean() * 100
    print(f"\n{'='*60}\n{market.upper()}: {len(allp):,} daily levels | baseline HOLD {base:.1f}%\n{'='*60}")
    print("  (1) formation volume (swing-bar vol vs 20-bar avg):")
    for t in ['low', 'mid', 'high']:
        d = allp[allp['ft'] == t]
        print(f"      {t:>4}: HOLD {d['held'].mean()*100:5.1f}%  (n={len(d):,})")
    hi = allp[allp['ft'] == 'high']['held'].mean()*100
    loo = allp[allp['ft'] == 'low']['held'].mean()*100
    print(f"      → high − low = {hi-loo:+.1f}pp")
    print("  (2) volume-at-price (cumulative vol traded AT the level):")
    for t in ['low', 'mid', 'high']:
        d = allp[allp['vt'] == t]
        print(f"      {t:>4}: HOLD {d['held'].mean()*100:5.1f}%  (n={len(d):,})")
    hi = allp[allp['vt'] == 'high']['held'].mean()*100
    loo = allp[allp['vt'] == 'low']['held'].mean()*100
    print(f"      → high − low = {hi-loo:+.1f}pp")


def main():
    import os
    for market, path in DAILY.items():
        if not os.path.exists(path):
            print(f"{market}: {path} missing — run fetch_daily_volume.py first"); continue
        run(market, path)


if __name__ == '__main__':
    main()
