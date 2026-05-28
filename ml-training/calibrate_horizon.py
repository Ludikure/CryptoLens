"""
Horizon-parametrized training. Same model architecture as calibrate_v12_stocks.py
(XGBoost d5 t100 stocks, LightGBM d4 t150 crypto, walk-forward CV with isotonic
calibration capped at 0.85), but the target column and output filename are
parametrized so we can fit dedicated 48h or 72h heads without overwriting v12.

Use only AFTER persistence-analysis has shown that the 24h-trained model does
NOT carry signal at the longer horizon. Otherwise you're solving a non-problem.

Examples:
    # Baseline (replicates v12 with this script's defaults):
    python calibrate_horizon.py --horizon 24 --source csv_exports_node --suffix mac24

    # 48h head, both markets:
    python calibrate_horizon.py --horizon 48 --source csv_exports_node --suffix h48

    # 72h head, stocks only (skip crypto):
    python calibrate_horizon.py --horizon 72 --source csv_exports_node --suffix h72 --skip-crypto

Output filenames: ml-model-{market}-{suffix}.json (so you keep your v12 production
files untouched until you've evaluated the candidate).
"""

import argparse
import sys
sys.path.insert(0, '/Users/bojanmihovilovic/CryptoLens/ml-training')

import calibrate_v12_stocks as v12
import pandas as pd

TARGET_COLUMN = {24: 'fwdMaxFavR', 48: 'fwdMaxFavR48H', 72: 'fwdMaxFavR72H'}


def load_symbol_with_horizon(symbol, is_crypto, horizon, source_dir, threshold=1.5):
    """Drop-in for v12.load_symbol that picks the target column by horizon and
    handles ms-stamped CSVs (Node CLI default at the time of writing) by
    normalizing to seconds when the values look out of range."""
    import os
    suffix = 'USDT' if is_crypto else ''
    path = f'{source_dir}/{symbol}{suffix}.csv'
    if not os.path.isfile(path):
        print(f"  MISSING: {path}")
        return None
    df = pd.read_csv(path)
    if 'symbol' not in df.columns:
        df['symbol'] = symbol
    target_col = TARGET_COLUMN[horizon]
    if target_col not in df.columns:
        print(f"  WARNING: {symbol} missing {target_col}")
        return None
    # Normalize ms timestamps to seconds. Anything past 10^11 is plainly ms
    # (4970 AD in seconds). The downstream walk-forward CV uses pd.to_datetime
    # with unit='s' so the unit must be consistent.
    if (df['timestamp'] > 1e11).any():
        df['timestamp'] = (df['timestamp'] // 1000).astype(int)
    valid = df[df[target_col].notna() & df['fwdReturn24H'].notna()].copy()
    valid['goodR'] = (valid[target_col] >= threshold).astype(int)
    for feat in v12.FEATURES:
        if feat not in valid.columns:
            if feat == 'takerRatioRaw': default = 1.0
            elif feat == 'longPctRaw': default = 50.0
            elif feat in ('daysToEarnings', 'daysSinceEarnings'): default = 60.0
            else: default = 0.0
            valid[feat] = default
    return valid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--horizon', type=int, choices=[24, 48, 72], required=True)
    ap.add_argument('--source', default='csv_exports_node',
                    help="Subdir under ml-training/ containing the per-symbol CSVs")
    ap.add_argument('--suffix', required=True,
                    help="Filename suffix for the output model (e.g. 'h72' → ml-model-stock-h72.json)")
    ap.add_argument('--skip-crypto', action='store_true')
    ap.add_argument('--skip-stocks', action='store_true')
    ap.add_argument('--threshold', type=float, default=1.5,
                    help="goodR threshold in ATR multiples. 1.5 matches v12 baseline; "
                         "2.0 recommended for 72h horizon (1.5 saturates near 95%% base rate).")
    args = ap.parse_args()

    source_dir = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{args.source}'
    horizon = args.horizon
    target_col = TARGET_COLUMN[horizon]

    # Patch the v12 module's loader + output paths in-place. Lighter than
    # forking the whole training script for a target-column swap.
    v12.DOWNLOADS = source_dir
    original_load = v12.load_symbol
    v12.load_symbol = lambda sym, is_c: load_symbol_with_horizon(sym, is_c, horizon, source_dir, args.threshold)

    # Output filename includes suffix. Hijack export_model to redirect.
    original_export = v12.export_model
    def export_with_suffix(market, model, n_samples, x_cal, y_cal, is_lgb):
        import json, shutil
        trees, base_score = v12.extract_trees(model, is_lgb)
        model_type = 'lightgbm' if is_lgb else 'xgboost'
        m = {
            'features': v12.FEATURES, 'trees': trees, 'base_score': base_score,
            'version': 12, 'market': market, 'engine': model_type,
            'n_features': len(v12.FEATURES), 'n_trees': len(trees), 'n_samples': n_samples,
            'model_type': 'classifier', 'target': f'goodR_{horizon}h_{args.threshold}',
            'calibration': {'x': x_cal, 'y': y_cal, 'cap': v12.CAP, 'method': 'isotonic'},
            'description': f'{market} ({model_type}) — goodR = {target_col}>={args.threshold}, {n_samples} bars',
        }
        out_path = f'{v12.WORKER}/ml-model-{market}-{args.suffix}.json'
        with open(out_path, 'w') as f:
            json.dump(m, f)
        print(f"  wrote {out_path} ({len(trees)} trees, {model_type}, {len(x_cal)} cal breakpoints)")
        # Don't auto-copy to iOS bundle — these are experimental candidates, not
        # production replacements. Promote manually after evaluating WF accuracy.
    v12.export_model = export_with_suffix

    print("=" * 60)
    print(f"Horizon training — {horizon}h target ({target_col})")
    print(f"  CSV source: {source_dir}")
    print(f"  Output suffix: {args.suffix}")
    print("=" * 60)

    if not args.skip_crypto:
        v12.calibrate_market(v12.CRYPTO_SYMBOLS, True, "Crypto", "crypto")
    if not args.skip_stocks:
        v12.calibrate_market(v12.STOCK_SYMBOLS, False, "Stocks", "stock")


if __name__ == '__main__':
    main()
