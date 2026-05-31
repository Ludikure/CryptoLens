#!/usr/bin/env python3
"""
Leakage check for the "crypto direction is 76-94% predictable at high ML" finding.

If the accuracy comes from genuine momentum, the PREVIOUS bar's indicator should still
predict the next bar's forward return at similar (slightly lower) accuracy. If it comes
from same-bar/alignment leakage (or look-ahead in features), lagging the indicator by
one bar collapses accuracy to ~50%.

Compares, on crypto high-ML (ML>=0.70) holdout bars:
  dStoch[T]    → sign(fwdReturn24H[T])      (the original)
  dStoch[T-1]  → sign(fwdReturn24H[T])      (indicator lagged one 4H bar)
  dStoch[T-2]  → sign(fwdReturn24H[T])      (lagged two bars)
Also shuffles the indicator within the high-ML set as a true-null control (~50%).

Run:  python3 direction_lag_test.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
P1 = __import__('phase1_meta')


def acc(dirv, up):
    sel = (dirv != 0) & ~np.isnan(dirv.astype(float))
    n = int(sel.sum())
    return n, (((dirv[sel] > 0) == up[sel]).mean() * 100 if n else 0.0)


def run(market='crypto'):
    print(f"\n{'='*78}\n{market.upper()} — lag/leakage test (high-ML holdout direction accuracy)\n{'='*78}")
    df, _ = H.load_market(market)
    df = P1.add_labels(df)
    sel, hold, b = H.split_holdout(df)
    mq = H.make_model(); mq.fit(sel[H.FEATURES].fillna(0), sel['goodR'])
    hv = hold.copy()
    hv['mlProb'] = mq.predict_proba(hv[H.FEATURES].fillna(0))[:, 1]
    hv = hv[hv['fwdReturn24H'].notna()].copy()
    # per-symbol lagged indicator (shift within each symbol, chronological)
    hv = hv.sort_values(['symbol', 'timestamp']).reset_index(drop=True)
    hv['dStoch'] = hv['dStochCross'].fillna(0).astype(int)
    hv['dStoch_lag1'] = hv.groupby('symbol')['dStoch'].shift(1)
    hv['dStoch_lag2'] = hv.groupby('symbol')['dStoch'].shift(2)

    high = hv[hv['mlProb'] >= 0.70].copy()
    up = (high['fwdReturn24H'].values > 0)
    print(f"  high-ML (>=0.70) bars: {len(high):,}  P(up)={up.mean()*100:.0f}%\n")

    rng = np.random.default_rng(0)
    variants = [
        ('dStoch[T]   (original)', high['dStoch'].values.astype(float)),
        ('dStoch[T-1] (lag 1 bar)', high['dStoch_lag1'].values.astype(float)),
        ('dStoch[T-2] (lag 2 bars)', high['dStoch_lag2'].values.astype(float)),
        ('dStoch shuffled (null)', rng.permutation(high['dStoch'].values).astype(float)),
    ]
    print(f"    {'variant':<26} {'fires':>6} {'dir-acc':>8}")
    print("    " + "-"*44)
    for name, d in variants:
        n, a = acc(d, up)
        print(f"    {name:<26} {n:>6,} {a:>7.1f}%")
    print("\n  Real momentum → lag1/lag2 stay well above 50%; leakage → they collapse to ~50%.")


if __name__ == '__main__':
    run('crypto')
