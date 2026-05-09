"""
Realistic-strategy PnL test.

Simulates: LLM picks a direction at bar T (modeled as random 50/50 since we
established direction prediction at any horizon is ~50%). 24h later, check:
  - Trade in profit in LLM direction?  → HOLD for another 48h (close at 72h)
  - Trade against LLM direction?       → CUT at 24h (take the 24h adverse move as loss)

Then aggregate full-strategy stats. Compares to two baselines:
  (a) "follow 24h" (omniscient, requires future info — earlier holding_pnl_test)
  (b) random direction with no 24h cut (pure 72h hold from random entry)

Random seed fixed at 42 for reproducibility. We also report results bucketed by
ML probability so you can see whether high-quality bars still benefit even with
random entry direction.

Usage:
    python strategy_pnl_test.py --src csv_exports_node
"""

import argparse
import os
import sys
import numpy as np
import pandas as pd
sys.path.insert(0, '/Users/bojanmihovilovic/CryptoLens/ml-training')
import calibrate_v12_stocks as v12
from holding_pnl_test import CRYPTO_MODEL, STOCK_MODEL, predict_batch, bucket_key, ORDER

THRESHOLD = 0.3  # min |24h move| to enter — keeps us out of dead-flat bars
RNG_SEED = 42


def load_market(src_dir, symbols, suffix):
    parts = []
    for s in symbols:
        path = f'{src_dir}/{s}{suffix}.csv'
        if not os.path.isfile(path): continue
        df = pd.read_csv(path)
        if 'fwdReturn24H' not in df.columns or 'fwdReturn72H' not in df.columns: continue
        if (df['timestamp'] > 1e11).any():
            df['timestamp'] = (df['timestamp'] // 1000).astype(int)
        df = df[df['fwdReturn24H'].notna() & df['fwdReturn72H'].notna()].copy()
        df = df[df['fwdReturn24H'].abs() >= THRESHOLD]
        if len(df) == 0: continue
        for feat in v12.FEATURES:
            if feat not in df.columns:
                df[feat] = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else 0.0)
        parts.append(df)
    return pd.concat(parts, ignore_index=True) if parts else None


def report_strategy(label, model, data, threshold=THRESHOLD):
    print(f"\n=== {label} ({len(data):,} bars) ===")

    feat_arr = data[v12.FEATURES].fillna(0).values.astype(np.float64)
    print(f"  scoring with model...")
    probs = predict_batch(feat_arr, model)

    rng = np.random.default_rng(RNG_SEED)
    direction = rng.choice([-1, 1], size=len(data))  # LLM proxy: 50/50

    r24 = data['fwdReturn24H'].values
    r72 = data['fwdReturn72H'].values

    # ----- Strategy B: enter AT T+24h in direction of the 24h move, hold 48h more -----
    # PnL = sign(r24) * (price_T+72h - price_T+24h) / price_T+24h
    # In return terms (since r24 and r72 are pct from T): this works out to
    # sign(r24) * (r72 - r24) / (1 + r24/100). The (1 + r24/100) divisor is ~1, so
    # we approximate as sign(r24) * (r72 - r24) — the residual after stripping out
    # the 24h move that already happened.
    sign_r24 = np.sign(r24)
    pnl_B = sign_r24 * (r72 - r24) / (1 + r24 / 100.0)
    print(f"\n  Strategy B: WAIT 24h, observe direction of 24h move, enter at T+24h, exit at T+72h")
    win_B = (pnl_B > 0).mean() * 100
    avg_B = pnl_B.mean()
    med_B = np.median(pnl_B)
    print(f"    overall:  win {win_B:.1f}%, avg PnL {avg_B:+.3f}%, median {med_B:+.3f}%")
    print(f"    by ML bucket:")
    print(f"      {'bucket':<9} {'n':>8}  {'win':>7} {'avg PnL':>9} {'median':>8}")
    for k in ORDER:
        mask = np.array([bucket_key(p) == k for p in probs])
        nb = mask.sum()
        if nb < 100: continue
        wb = (pnl_B[mask] > 0).mean() * 100
        ab = pnl_B[mask].mean()
        mb = np.median(pnl_B[mask])
        print(f"      {k:<9} {nb:>8,d}  {wb:>6.1f}% {ab:>+9.3f}% {mb:>+8.3f}%")
    # Also bucket by |r24| size — bigger 24h moves might mean stronger continuation, OR mean-reversion
    print(f"    by 24h-move size (|r24|):")
    print(f"      {'r24 band':<10} {'n':>8}  {'win':>7} {'avg PnL':>9} {'avg |r24|':>10}")
    bands = [(0.3, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 100.0)]
    for lo, hi in bands:
        mask = (np.abs(r24) >= lo) & (np.abs(r24) < hi)
        nb = mask.sum()
        if nb < 100: continue
        wb = (pnl_B[mask] > 0).mean() * 100
        ab = pnl_B[mask].mean()
        mr = np.abs(r24[mask]).mean()
        print(f"      {lo:.1f}-{hi:.1f}%   {nb:>8,d}  {wb:>6.1f}% {ab:>+9.3f}% {mr:>+10.3f}%")

    print(f"\n  ----- Strategy A (for comparison) -----")

    # 24h PnL relative to picked direction. Positive → trade is winning at 24h.
    pnl_24h = direction * r24

    # Decision: hold if winning at 24h, cut otherwise.
    held_mask = pnl_24h > 0

    # Final PnL: held → direction*r72; cut → pnl_24h (which is negative since held_mask false).
    pnl_final = np.where(held_mask, direction * r72, pnl_24h)

    n = len(data)
    n_held = held_mask.sum()
    n_cut = n - n_held

    print(f"\n  Strategy: random dir at T → hold if +24h, cut if -24h, exit at 72h")
    print(f"    held:   {n_held:>9,d} ({n_held/n*100:.1f}%) — PnL on these = direction * fwdReturn72H")
    print(f"    cut:    {n_cut:>9,d} ({n_cut/n*100:.1f}%) — PnL on these = -|fwdReturn24H| (24h adverse move)")

    win = (pnl_final > 0).mean() * 100
    avg = pnl_final.mean()
    med = np.median(pnl_final)
    print(f"\n  Per-trade stats (full strategy, every bar takes a trade):")
    print(f"    win rate:      {win:>6.1f}%  (random=50%)")
    print(f"    avg PnL:       {avg:>+6.3f}%")
    print(f"    median PnL:    {med:>+6.3f}%")
    print(f"    held subset avg PnL: {(direction[held_mask]*r72[held_mask]).mean():+.3f}%  (this is the +3-4% number from before)")
    print(f"    cut subset avg PnL:  {pnl_24h[~held_mask].mean():+.3f}%  (negative — 24h move against you)")

    # Bucket by ML
    print(f"\n  By ML quality bucket:")
    print(f"    {'bucket':<9} {'n':>8}  {'cut%':>5} {'hold%':>6}  {'win all':>7} {'avg all':>9} {'avg held':>9} {'avg cut':>9}")
    for k in ORDER:
        mask = np.array([bucket_key(p) == k for p in probs])
        nb = mask.sum()
        if nb < 100: continue
        b_held = held_mask & mask
        b_cut = ~held_mask & mask
        win_b = (pnl_final[mask] > 0).mean() * 100
        avg_b = pnl_final[mask].mean()
        avg_h = (direction[b_held] * r72[b_held]).mean() if b_held.any() else 0.0
        avg_c = pnl_24h[b_cut].mean() if b_cut.any() else 0.0
        cut_pct = b_cut.sum() / nb * 100
        print(f"    {k:<9} {nb:>8,d}  {cut_pct:>4.0f}% {100-cut_pct:>5.0f}%  {win_b:>6.1f}% {avg_b:>+9.3f}% {avg_h:>+9.3f}% {avg_c:>+9.3f}%")

    # Baseline comparison: random direction, no 24h cut, hold blindly to 72h.
    blind_pnl = direction * r72
    blind_win = (blind_pnl > 0).mean() * 100
    blind_avg = blind_pnl.mean()
    print(f"\n  Baseline: random dir + hold blindly to 72h (no 24h cut):")
    print(f"    win rate: {blind_win:.1f}%   avg PnL: {blind_avg:+.3f}%   (~50% / ~0% expected)")
    print(f"    ⇒ the 24h-cut filter improves win rate by {win - blind_win:+.1f} pp and avg PnL by {avg - blind_avg:+.3f} pp")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='csv_exports_node')
    args = ap.parse_args()
    src_dir = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{args.src}'

    print("=" * 80)
    print("Strategy-PnL test: random direction + 24h confirm/cut + hold to 72h")
    print("=" * 80)

    crypto = load_market(src_dir, v12.CRYPTO_SYMBOLS, 'USDT')
    if crypto is not None:
        report_strategy("CRYPTO (model: crypto v10)", CRYPTO_MODEL, crypto)

    stocks = load_market(src_dir, v12.STOCK_SYMBOLS, '')
    if stocks is not None:
        report_strategy("STOCKS (model: stock v12)", STOCK_MODEL, stocks)


if __name__ == '__main__':
    main()
