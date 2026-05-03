"""
Test 2: Momentum continuation rate at 4H, conditional on ML conviction.

Question 1: What's the base rate of 4H momentum continuation in the data?
  P(next 4H direction == prev 4H direction)
  CLAUDE.md cites 75% — verify against actual data.

Question 2: Does high ML conviction make continuation MORE predictable?
  Stratify by mlProb buckets and report continuation rate per bucket.

Method:
1. Load all v11 stock CSVs (in chronological order per symbol)
2. For each consecutive pair of rows in same symbol: compute prev sign and next sign
3. Continuation = next sign == prev sign
4. Run v11 model to get OOF mlProb per row
5. Stratify continuation rate by mlProb bucket
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd

from calibrate_v11_stocks import (
    STOCK_SYMBOLS,
    load_symbol,
    downsample_daily,
    walk_forward_oof,
    make_stock_model,
)


def main():
    print("=" * 60)
    print("Momentum Continuation Test (4H)")
    print("=" * 60)

    print("\nLoading stock CSVs...")
    parts = []
    for sym in STOCK_SYMBOLS:
        d = load_symbol(sym, is_crypto=False)
        if d is None:
            continue
        d = downsample_daily(d).sort_values('timestamp').reset_index(drop=True)
        # Compute prev_sign by shifting fwdReturn4H within this symbol
        d['prev_fwdRet4H'] = d['fwdReturn4H'].shift(1)
        d['this_fwdRet4H'] = d['fwdReturn4H']
        d['symbol_id'] = sym
        parts.append(d)
    all_data = pd.concat(parts, ignore_index=True)
    # Drop rows with no prev (first bar per symbol) or invalid forward return
    valid = all_data[
        all_data['prev_fwdRet4H'].notna() &
        all_data['this_fwdRet4H'].notna() &
        all_data['fwdReturn24H'].notna() &
        all_data['fwdMaxFavR'].notna()
    ].copy()
    print(f"  total bars with prev+this 4H: {len(valid)}")

    # Continuation: same sign as previous bar
    valid['prev_up'] = (valid['prev_fwdRet4H'] > 0).astype(int)
    valid['this_up'] = (valid['this_fwdRet4H'] > 0).astype(int)
    valid['continued'] = (valid['prev_up'] == valid['this_up']).astype(int)

    pop_continuation = valid['continued'].mean() * 100
    pop_up_given_prev_up = valid[valid['prev_up'] == 1]['this_up'].mean() * 100
    pop_dn_given_prev_dn = valid[valid['prev_up'] == 0]['this_up'].apply(lambda x: 1 - x).mean() * 100
    print(f"  population P(this_up): {valid['this_up'].mean()*100:.1f}%")
    print(f"  population continuation rate: {pop_continuation:.1f}%")
    print(f"    P(up | prev up):   {pop_up_given_prev_up:.1f}%")
    print(f"    P(down | prev dn): {pop_dn_given_prev_dn:.1f}%")

    # Run WF CV to get OOF mlProb. Use same valid frame.
    valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)
    valid_sorted = valid.sort_values('timestamp').reset_index(drop=True)
    print("\nRunning walk-forward CV to get OOF goodR probabilities...")
    probs, y_goodR, _ = walk_forward_oof(valid_sorted, make_stock_model)
    print(f"  OOF samples: {len(probs)}")

    # Re-create val indices to align bullish/continuation labels
    n = len(valid_sorted)
    n_folds = 3
    purge = 48
    val_indices = []
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))
        val_start = train_end + purge
        val_end = int(n * (0.55 + i * 0.15)) if i < n_folds - 1 else n
        if val_start >= val_end:
            continue
        val_indices.extend(range(val_start, val_end))
    val_indices = np.array(val_indices)
    cont_val = valid_sorted['continued'].values[val_indices]
    prev_up_val = valid_sorted['prev_up'].values[val_indices]
    this_up_val = valid_sorted['this_up'].values[val_indices]
    assert len(cont_val) == len(probs)

    print("\n" + "=" * 60)
    print("CONTINUATION RATE BY ML CONVICTION BUCKET")
    print("=" * 60)
    print(f"{'Bucket':<22} {'N':>8} {'Continuation %':>17} {'P(up|prev up)':>16} {'P(dn|prev dn)':>16}")
    print("-" * 80)
    pop_cont = cont_val.mean() * 100
    print(f"{'POPULATION (OOF)':<22} {len(probs):>8} {pop_cont:>16.1f}%")
    print("-" * 80)

    buckets = [
        ('< 0.30',         lambda p: p < 0.30),
        ('0.30 - 0.50',    lambda p: (p >= 0.30) & (p < 0.50)),
        ('0.50 - 0.60',    lambda p: (p >= 0.50) & (p < 0.60)),
        ('0.60 - 0.70',    lambda p: (p >= 0.60) & (p < 0.70)),
        ('0.70 - 0.85',    lambda p: (p >= 0.70) & (p < 0.85)),
        ('>= 0.85',        lambda p: p >= 0.85),
    ]
    for name, predicate in buckets:
        mask = predicate(probs)
        n = mask.sum()
        if n < 50:
            print(f"{name:<22} {n:>8} {'(too few)':>17}")
            continue
        cont_pct = cont_val[mask].mean() * 100
        # Within this bucket, separate out prev-up and prev-down rows
        bucket_prev_up = mask & (prev_up_val == 1)
        bucket_prev_dn = mask & (prev_up_val == 0)
        if bucket_prev_up.sum() > 10:
            up_given_prev_up = this_up_val[bucket_prev_up].mean() * 100
        else:
            up_given_prev_up = float('nan')
        if bucket_prev_dn.sum() > 10:
            dn_given_prev_dn = (1 - this_up_val[bucket_prev_dn]).mean() * 100
        else:
            dn_given_prev_dn = float('nan')
        print(f"{name:<22} {n:>8} {cont_pct:>16.1f}% {up_given_prev_up:>15.1f}% {dn_given_prev_dn:>15.1f}%")

    # Bottom-line directional accuracy: predict "same as prev" on high conviction
    high_mask = probs >= 0.70
    if high_mask.sum() > 0:
        cont_at_high = cont_val[high_mask].mean() * 100
        print()
        print("Predict 'same direction as previous 4H bar' on mlProb >= 0.70:")
        print(f"  Accuracy: {cont_at_high:.1f}%")
        print(f"  Population continuation rate: {pop_cont:.1f}%")
        print(f"  Lift from ML conviction: {cont_at_high - pop_cont:+.1f}pp")


if __name__ == '__main__':
    main()
