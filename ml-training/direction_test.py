"""
Quick test: can the model predict directional moves at short horizons?

Re-tests the historical "direction is ~50%" finding with the current 111-feature
set. Doesn't export a model — just runs walk-forward CV and prints accuracy +
reliability buckets so we can see whether there's a tradable edge.

Targets supported (binary up/down classifier):
  --target dir4h    →  fwdReturn4H  > THRESHOLD%  (next 4H bar)
  --target dir12h   →  fwdReturn12H > THRESHOLD%  (3 4H bars / 12h)
  --target dir24h   →  fwdReturn24H > THRESHOLD%  (6 4H bars / 24h)

Default THRESHOLD is 0.3% — anything smaller is noise where "direction" is
meaningless. Reduces ambiguity at the decision boundary so the classifier is
graded on bars where there's an actual move to call.

Usage:
  # Stocks from the existing v12 export (already on disk, no waiting):
  python direction_test.py --target dir4h --source csv_exports_v12 --stocks

  # Crypto from whatever the mass backtest has produced so far:
  python direction_test.py --target dir4h --source csv_exports_node --crypto

  # Both markets, 24h target, with looser noise threshold:
  python direction_test.py --target dir24h --threshold 0.5
"""

import argparse
import os
import sys
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score

sys.path.insert(0, '/Users/bojanmihovilovic/CryptoLens/ml-training')
import calibrate_v12_stocks as v12

TARGET_COL = {'dir4h': 'fwdReturn4H', 'dir12h': 'fwdReturn12H', 'dir24h': 'fwdReturn24H'}


def load_csv(path, symbol, target_col, threshold):
    if not os.path.isfile(path):
        return None
    df = pd.read_csv(path)
    if 'symbol' not in df.columns:
        df['symbol'] = symbol
    if target_col not in df.columns:
        return None
    # Auto-detect ms vs s timestamps (Node CLI pre-2026-05-08 wrote ms, post writes s).
    if (df['timestamp'] > 1e11).any():
        df['timestamp'] = (df['timestamp'] // 1000).astype(int)

    # Filter to bars with a meaningful move. Drops the noise band around 0%
    # where "direction" is essentially undefined — keeps the test honest.
    valid = df[df[target_col].notna() & (df[target_col].abs() >= threshold)].copy()
    valid['target'] = (valid[target_col] > 0).astype(int)

    for feat in v12.FEATURES:
        if feat not in valid.columns:
            default = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else 0.0)
            valid[feat] = default
    return valid


def load_market(symbols, source_dir, is_crypto, target_col, threshold, label):
    print(f"\n--- Loading {label} from {source_dir} ---")
    parts = []
    for s in symbols:
        suffix = 'USDT' if is_crypto else ''
        path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{source_dir}/{s}{suffix}.csv'
        d = load_csv(path, s, target_col, threshold)
        if d is None:
            continue
        parts.append(d)
    if not parts:
        return None
    out = pd.concat(parts, ignore_index=True).sort_values('timestamp').reset_index(drop=True)
    up_rate = out['target'].mean() * 100
    print(f"  {len(parts)} symbols, {len(out):,} bars, baseline={up_rate:.1f}% up")
    return out


def walk_forward(data, n_splits=3, gap_bars=48, shuffle_targets=False, return_importance=False, feature_subset=None):
    """Expanding-window walk-forward with a purged gap (matches v12). Returns OOF
    predictions over the full dataset for accuracy + reliability analysis.
    `shuffle_targets`: scrambles y for the leakage sanity check."""
    n = len(data)
    fold_size = n // (n_splits + 1)
    oof_pred = np.full(n, np.nan)
    oof_true = data['target'].values

    feature_list = feature_subset if feature_subset is not None else v12.FEATURES
    X_all = data[feature_list].fillna(0).values
    y_all = data['target'].values
    if shuffle_targets:
        rng = np.random.default_rng(42)
        y_all = rng.permutation(y_all)
        oof_true = y_all

    last_clf = None
    for fold in range(n_splits):
        train_end = fold_size * (fold + 1)
        val_start = train_end + gap_bars
        val_end = min(val_start + fold_size, n)
        if val_start >= n:
            break

        X_tr, y_tr = X_all[:train_end], y_all[:train_end]
        X_v, y_v = X_all[val_start:val_end], y_all[val_start:val_end]

        clf = xgb.XGBClassifier(
            max_depth=5, n_estimators=100, learning_rate=0.05,
            objective='binary:logistic', eval_metric='logloss',
            n_jobs=-1, verbosity=0, tree_method='hist',
        )
        clf.fit(X_tr, y_tr)
        oof_pred[val_start:val_end] = clf.predict_proba(X_v)[:, 1]
        last_clf = clf
        acc = accuracy_score(y_v, (oof_pred[val_start:val_end] > 0.5).astype(int))
        try:
            auc = roc_auc_score(y_v, oof_pred[val_start:val_end])
        except ValueError:
            auc = float('nan')
        print(f"  fold {fold + 1}: train={train_end:,} val={val_end - val_start:,}  acc={acc * 100:.2f}%  auc={auc:.3f}")

    if return_importance and last_clf is not None:
        imps = last_clf.feature_importances_
        ranked = sorted(zip(feature_list, imps), key=lambda x: -x[1])
        print(f"\n  top 15 feature importances (last fold):")
        for name, imp in ranked[:15]:
            print(f"    {name:<24s}  {imp:.4f}")

    return oof_pred, oof_true


def reliability(probs, truth, edges=(0.4, 0.45, 0.5, 0.55, 0.6)):
    """Per-confidence-band accuracy. The interesting question for direction
    isn't "overall accuracy" — it's "are the high-conviction predictions reliably
    better than 50%?" If even the most confident predictions sit at 50%, there's
    no edge to extract."""
    print(f"\n  reliability buckets (P(up)):")
    print(f"    bucket          n     up%     AUC pred-mean")
    bands = [(-1, edges[0])] + [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)] + [(edges[-1], 2)]
    for lo, hi in bands:
        mask = (probs >= lo) & (probs < hi) & ~np.isnan(probs)
        n = mask.sum()
        if n < 30:
            continue
        up = truth[mask].mean() * 100
        pm = probs[mask].mean() * 100
        label = f"{lo:.2f}–{hi:.2f}"
        print(f"    {label:>12s}  {n:>6,d}  {up:5.1f}%   {pm:5.1f}%")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', choices=['dir4h', 'dir12h', 'dir24h'], required=True)
    ap.add_argument('--source', default='csv_exports_v12')
    ap.add_argument('--threshold', type=float, default=0.3,
                    help="Min absolute return percent to include a bar — filters the noise band around 0")
    ap.add_argument('--crypto', action='store_true')
    ap.add_argument('--stocks', action='store_true')
    args = ap.parse_args()

    if not args.crypto and not args.stocks:
        # Default: run both if neither specified.
        args.crypto = args.stocks = True

    target_col = TARGET_COL[args.target]
    print("=" * 60)
    print(f"Direction test — {args.target} (target={target_col})")
    print(f"  source={args.source}, threshold={args.threshold}%")
    print("=" * 60)

    if args.stocks:
        data = load_market(v12.STOCK_SYMBOLS, args.source, False, target_col, args.threshold, "Stocks")
        if data is not None:
            print(f"\n  walk-forward CV (XGBoost d5 t100):")
            probs, truth = walk_forward(data, return_importance=True)
            mask = ~np.isnan(probs)
            overall_acc = accuracy_score(truth[mask], (probs[mask] > 0.5).astype(int))
            print(f"\n  STOCKS overall WF acc: {overall_acc * 100:.2f}%  (baseline {truth[mask].mean() * 100:.1f}% up)")
            reliability(probs, truth)
            print(f"\n  --- LEAKAGE SANITY CHECK: shuffled targets ---")
            sh_probs, sh_truth = walk_forward(data, shuffle_targets=True)
            sh_mask = ~np.isnan(sh_probs)
            sh_acc = accuracy_score(sh_truth[sh_mask], (sh_probs[sh_mask] > 0.5).astype(int))
            print(f"  STOCKS shuffled WF acc: {sh_acc * 100:.2f}%  (should be ≈50%; >55% means eval is bugged)")

    if args.crypto:
        data = load_market(v12.CRYPTO_SYMBOLS, args.source, True, target_col, args.threshold, "Crypto")
        if data is not None:
            print(f"\n  walk-forward CV (XGBoost d5 t100):")
            probs, truth = walk_forward(data)
            mask = ~np.isnan(probs)
            overall_acc = accuracy_score(truth[mask], (probs[mask] > 0.5).astype(int))
            print(f"\n  CRYPTO overall WF acc: {overall_acc * 100:.2f}%  (baseline {truth[mask].mean() * 100:.1f}% up)")
            reliability(probs, truth)


if __name__ == '__main__':
    main()
