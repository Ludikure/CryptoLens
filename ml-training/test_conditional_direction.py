"""
Test 1: Does ML predict direction conditional on high goodR conviction?

Hypothesis: when the v11 model predicts >=70% goodR (tradeable move likely),
direction may also be more predictable than 50/50 — because the patterns that
trigger high conviction (breakouts, exhaustion, vol expansion) have inherent
directional bias.

Method:
1. Load all v11 stock CSVs
2. Run v11 XGBoost walk-forward CV → OOF mlProb per row
3. Stratify by mlProb buckets: <0.30, 0.30-0.50, 0.50-0.60, 0.60-0.70, >=0.70
4. For each bucket, compute % of bars with fwdReturn24H > 0
5. Compare against population baseline (regime-driven bias)

If high-conviction subset has significantly different directional skew than
the population, ML conviction adds directional info.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd

from calibrate_v11_stocks import (
    FEATURES,
    STOCK_SYMBOLS,
    DOWNLOADS,
    load_symbol,
    downsample_daily,
    walk_forward_oof,
    make_stock_model,
)


def main():
    print("=" * 60)
    print("Conditional Direction Test")
    print("=" * 60)

    print("\nLoading stock CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d)
        parts.append(d)
    data = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    print(f"  total: {len(data)} bars")

    # Direction target: forward 24H return > 0
    if 'fwdReturn24H' not in data.columns:
        print("ERROR: fwdReturn24H column missing from CSVs")
        return
    valid = data[data['fwdReturn24H'].notna()].copy()
    valid['bullish'] = (valid['fwdReturn24H'] > 0).astype(int)
    print(f"  bars with valid fwdReturn24H: {len(valid)}")
    print(f"  population bullish rate: {valid['bullish'].mean()*100:.1f}%")

    # Get OOF mlProb (goodR probability) via WF CV
    print("\nRunning walk-forward CV to get OOF goodR probabilities...")
    probs, y_goodR, _ = walk_forward_oof(valid, make_stock_model)
    print(f"  OOF samples: {len(probs)}")

    # The OOF samples come from val folds (not the entire valid set). Take the matching slice.
    # walk_forward_oof concatenates val folds in order, so probs[i] corresponds to the i-th val row.
    # We need the bullish labels for the same val rows. Since folds are deterministic, we re-create them:
    n = len(valid)
    n_folds = 3
    purge = 48
    val_starts = []
    val_ends = []
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        val_starts.append(val_start)
        val_ends.append(val_end)

    val_indices = []
    for vs, ve in zip(val_starts, val_ends):
        val_indices.extend(range(vs, ve))
    val_indices = np.array(val_indices)
    bullish_val = valid['bullish'].values[val_indices]
    fwd_ret_val = valid['fwdReturn24H'].values[val_indices]
    assert len(bullish_val) == len(probs), f"size mismatch: {len(bullish_val)} vs {len(probs)}"

    print("\n" + "=" * 60)
    print("DIRECTIONAL BIAS BY ML CONVICTION BUCKET (raw probs, not calibrated)")
    print("=" * 60)
    print(f"{'Bucket':<22} {'N':>8} {'Bullish %':>11} {'Mean fwdRet24H':>16}")
    print("-" * 60)

    buckets = [
        ('< 0.30',         lambda p: p < 0.30),
        ('0.30 - 0.50',    lambda p: (p >= 0.30) & (p < 0.50)),
        ('0.50 - 0.60',    lambda p: (p >= 0.50) & (p < 0.60)),
        ('0.60 - 0.70',    lambda p: (p >= 0.60) & (p < 0.70)),
        ('0.70 - 0.85',    lambda p: (p >= 0.70) & (p < 0.85)),
        ('>= 0.85',        lambda p: p >= 0.85),
    ]
    pop_bullish = bullish_val.mean()
    print(f"{'POPULATION':<22} {len(probs):>8} {pop_bullish*100:>10.1f}% {fwd_ret_val.mean()*100:>15.3f}%")
    print("-" * 60)
    for name, predicate in buckets:
        mask = predicate(probs)
        n = mask.sum()
        if n < 50:
            print(f"{name:<22} {n:>8} {'(too few)':>11}")
            continue
        bull_pct = bullish_val[mask].mean() * 100
        mean_ret = fwd_ret_val[mask].mean() * 100
        delta_vs_pop = bull_pct - pop_bullish * 100
        print(f"{name:<22} {n:>8} {bull_pct:>10.1f}% {mean_ret:>15.3f}%   (Δ vs pop: {delta_vs_pop:+.1f}pp)")

    # Top-bucket directional accuracy as if we always bet long
    top_mask = probs >= 0.70
    if top_mask.sum() > 0:
        top_long_acc = bullish_val[top_mask].mean() * 100
        print()
        print(f"If we always predicted BULL on mlProb >= 0.70:")
        print(f"  Directional accuracy: {top_long_acc:.1f}%  (n={top_mask.sum()})")
        print(f"  Coin-flip baseline: 50.0%")
        print(f"  Population bullish rate: {pop_bullish*100:.1f}% (regime-driven)")
        signal_above_regime = top_long_acc - pop_bullish * 100
        print(f"  Signal above regime: {signal_above_regime:+.1f}pp")

    # Check the inverse: low-conviction bars should be mostly direction-noise
    low_mask = probs < 0.30
    if low_mask.sum() > 0:
        low_bullish = bullish_val[low_mask].mean() * 100
        print()
        print(f"Sanity check — low-conviction (mlProb < 0.30):")
        print(f"  N={low_mask.sum()}, bullish %={low_bullish:.1f}% (should be near population bullish rate if direction is uninformed)")


if __name__ == '__main__':
    main()
