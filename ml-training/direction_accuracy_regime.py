#!/usr/bin/env python3
"""
Stress-test the "high ML → indicators predict direction" finding ACROSS REGIMES.

The single holdout is a recent trending window; momentum-continuation looks great
there. The honest question: does directional accuracy at high ML hold in the 2022
bear and choppy folds, or collapse toward the majority baseline?

Multi-fold clean WF (edge_revalidate.wf_clean, folds span 2022-bear → 2026). Per
fold, among ML>=0.70 bars: directional accuracy of dStoch / union vs sign(fwdReturn24H),
with the per-fold majority baseline (so a one-sided trend can't fake it).

Run:  python3 direction_accuracy_regime.py
"""
import numpy as np
import pandas as pd

H = __import__('_harness')
rev = __import__('edge_revalidate')
ev = __import__('edge_validation')


def dir_for(df):
    a = df['biasAlignment'].values
    bias = np.where(a == 'aligned_bullish', 1, np.where(a == 'aligned_bearish', -1, 0))
    dstoch = df['dStochCross'].fillna(0).astype(int).values
    conflict = (bias != 0) & (dstoch != 0) & (bias != dstoch)
    union = np.where(bias != 0, bias, dstoch); union = np.where(conflict, 0, union)
    agree = np.where((bias != 0) & (dstoch != 0) & (bias == dstoch), bias, 0)
    return dstoch, union, agree


def accuracy(dirv, up):
    sel = dirv != 0
    n = int(sel.sum())
    return n, (((dirv[sel] > 0) == up[sel]).mean() * 100 if n else 0.0)


def run(market, csv_dir, candles):
    print(f"\n{'='*92}\n{market.upper()} — directional accuracy at ML>=0.70 by regime fold\n{'='*92}")
    df = ev.load_features(csv_dir)
    df = df[df['fwdReturn24H'].notna()].copy()
    val = rev.wf_clean(df)
    val = val[val['fwdReturn24H'].notna()].reset_index(drop=True)
    fold_dates = {f: (pd.to_datetime(g['timestamp'].min(), unit='s').date(),
                      pd.to_datetime(g['timestamp'].max(), unit='s').date())
                  for f, g in val.groupby('fold')}
    print(f"  {'fold / window':<28} {'n@ML.70':>8} {'P(up)':>6} {'maj':>5} "
          f"{'dStoch':>8} {'union':>8} {'agree':>8}  (acc vs majority)")
    print("  " + "-"*92)
    for f in sorted(fold_dates):
        sub = val[(val['fold'] == f) & (val['mlProb'] >= 0.70)].copy()
        if len(sub) < 50:
            print(f"  f{f} {fold_dates[f][0]}→{fold_dates[f][1]}: n={len(sub)} (too small)"); continue
        up = (sub['fwdReturn24H'].values > 0)
        up_pct = up.mean() * 100
        maj = max(up_pct, 100 - up_pct)
        ds, un, ag = dir_for(sub)
        _, a_ds = accuracy(ds, up); _, a_un = accuracy(un, up); n_ag, a_ag = accuracy(ag, up)
        d1, d2 = pd.to_datetime(fold_dates[f][0]), pd.to_datetime(fold_dates[f][1])
        win = f"f{f} {d1.date()}→{d2.date()}"
        ag_str = f"{a_ag:.0f}%(n{n_ag})" if n_ag >= 20 else f"n{n_ag}"
        print(f"  {win:<28} {len(sub):>8,} {up_pct:>5.0f}% {maj:>4.0f}% "
              f"{a_ds:>6.1f}%({a_ds-maj:+.0f}) {a_un:>6.1f}%({a_un-maj:+.0f}) {ag_str:>10}")


def main():
    run('crypto', 'csv_exports_v11', 'crypto_candles_4h.csv.gz')
    run('stock', 'csv_exports_v13', 'stock_candles_4h.csv.gz')


if __name__ == '__main__':
    main()
