"""
Trade-outcome test for the multi-horizon hypothesis.

For each bar, simulate "follow the 24h direction" — i.e. if fwdReturn24H > threshold
go long, if < -threshold go short. Then measure what that trade's PnL would be at
48h and 72h (close-to-close). Buckets by the existing ML quality probability so we
can see whether high-ML setups carry the trade direction further out in time.

This answers the question persistence-analysis only addressed by sign-agreement:
"if I commit to the 24h direction, am I still in profit at 72h, and by how much?"

Usage:
    python holding_pnl_test.py --src csv_exports_node
"""

import argparse
import os
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, '/Users/bojanmihovilovic/CryptoLens/ml-training')
sys.path.insert(0, '/Users/bojanmihovilovic/CryptoLens/marketscope-worker')
import calibrate_v12_stocks as v12

# ML model JSONs live alongside the worker. We load them directly to score each row
# instead of routing through Node — keeps the analysis in one process. The XGBoost
# tree format is nested with `children` arrays; we flatten each tree to a dict
# nodeid->node so the iterative walker below can index by ID.
import json
WORKER_SRC = '/Users/bojanmihovilovic/CryptoLens/marketscope-worker/src'

def flatten_tree(node, out=None):
    if out is None:
        out = {}
    out[node['nodeid']] = node
    for child in node.get('children', []):
        flatten_tree(child, out)
    return out

def load_model(path):
    m = json.load(open(path))
    m['trees_flat'] = [flatten_tree(t) for t in m['trees']]
    return m

CRYPTO_MODEL = load_model(f'{WORKER_SRC}/ml-model-crypto.json')
STOCK_MODEL = load_model(f'{WORKER_SRC}/ml-model-stock.json')


def sigmoid(x): return 1.0 / (1.0 + np.exp(-x))


def isotonic_apply(x_values, x_breaks, y_breaks, cap):
    """Mirror the worker's isotonic interpolation. Vectorized for speed."""
    out = np.interp(x_values, x_breaks, y_breaks)
    return np.minimum(out, cap)


def predict_batch(features_array, model):
    """Vectorized tree evaluation. features_array shape: (n_rows, n_features).
    Each tree is the pre-flattened dict (nodeid -> node) built by load_model().
    Nodes use XGBoost JSON keys: split (feature name), split_condition, yes, no,
    missing, leaf. Walks at most depth+1 hops per row."""
    feature_names = model['features']
    trees = model['trees_flat']
    base_score = model['base_score']
    n_rows = features_array.shape[0]
    feature_index = {name: i for i, name in enumerate(feature_names)}

    raw = np.full(n_rows, base_score, dtype=np.float64)
    for tree_idx, tree in enumerate(trees):
        idx = np.zeros(n_rows, dtype=np.int64)
        active = np.ones(n_rows, dtype=bool)
        leaf_values = np.zeros(n_rows, dtype=np.float64)
        for _ in range(30):
            if not active.any():
                break
            unique_nodes = np.unique(idx[active])
            for node_id in unique_nodes:
                node = tree.get(int(node_id))
                if node is None:
                    # Defensive: node not in flat lookup. Treat as leaf=0.
                    rows_at_node = active & (idx == node_id)
                    active[rows_at_node] = False
                    continue
                rows_at_node = active & (idx == node_id)
                if 'leaf' in node:
                    leaf_values[rows_at_node] = node['leaf']
                    active[rows_at_node] = False
                else:
                    fi = feature_index.get(node['split'])
                    if fi is None:
                        idx[rows_at_node] = node['missing']
                        continue
                    feat_vals = features_array[rows_at_node, fi]
                    go_yes = feat_vals < node['split_condition']
                    sub_idx = np.where(rows_at_node)[0]
                    idx[sub_idx[go_yes]] = node['yes']
                    idx[sub_idx[~go_yes]] = node['no']
        raw += leaf_values

    probs = sigmoid(raw)
    cal = model.get('calibration')
    if cal:
        probs = isotonic_apply(probs, cal['x'], cal['y'], cal['cap'])
    return probs


def bucket_key(p):
    if p < 0.30: return '<30%'
    if p < 0.50: return '30-50%'
    if p < 0.60: return '50-60%'
    if p < 0.70: return '60-70%'
    if p < 0.85: return '70-85%'
    return '85%+'


ORDER = ['<30%', '30-50%', '50-60%', '60-70%', '70-85%', '85%+']


def analyze(src_dir, label, model, symbols, suffix, threshold=0.3):
    print(f"\n=== {label} ===")
    parts = []
    for s in symbols:
        path = f'{src_dir}/{s}{suffix}.csv'
        if not os.path.isfile(path):
            continue
        df = pd.read_csv(path)
        if 'fwdReturn24H' not in df.columns or 'fwdReturn72H' not in df.columns:
            continue
        # Auto-normalize ms timestamps to s if needed
        if (df['timestamp'] > 1e11).any():
            df['timestamp'] = (df['timestamp'] // 1000).astype(int)
        df = df[df['fwdReturn24H'].notna() & df['fwdReturn72H'].notna()].copy()
        # Filter to bars where 24h had a meaningful move (otherwise no clear "direction
        # to follow"). Same threshold persistence-analysis used.
        df = df[df['fwdReturn24H'].abs() >= threshold]
        if len(df) == 0:
            continue
        for feat in v12.FEATURES:
            if feat not in df.columns:
                df[feat] = 1.0 if feat == 'takerRatioRaw' else (50.0 if feat == 'longPctRaw' else 0.0)
        parts.append(df)
    if not parts:
        print(f"  no data")
        return
    data = pd.concat(parts, ignore_index=True)
    print(f"  {len(data):,} bars (after 24h-move filter)")

    feat_arr = data[v12.FEATURES].fillna(0).values.astype(np.float64)
    print(f"  scoring {len(data):,} bars with model...")
    probs = predict_batch(feat_arr, model)
    data['ml_prob'] = probs

    # Trade direction = sign of 24h move. Trade PnL at horizon = direction * fwdReturnHH.
    direction = np.sign(data['fwdReturn24H'].values)
    pnl_48h = direction * data['fwdReturn48H'].values
    pnl_72h = direction * data['fwdReturn72H'].values

    # Bucket by ML probability and report PnL stats.
    print(f"\n  Trade-outcome by ML bucket (long if 24h was up, short if down, hold N hours):")
    print(f"    {'bucket':<9} {'n':>8}  {'win 48h':>8} {'avg PnL 48h':>12}  {'win 72h':>8} {'avg PnL 72h':>12}  {'med 72h':>8}")
    for k in ORDER:
        mask = np.array([bucket_key(p) == k for p in probs])
        n = mask.sum()
        if n < 100:
            continue
        win_48 = (pnl_48h[mask] > 0).mean() * 100
        avg_48 = pnl_48h[mask].mean()
        win_72 = (pnl_72h[mask] > 0).mean() * 100
        avg_72 = pnl_72h[mask].mean()
        med_72 = np.median(pnl_72h[mask])
        print(f"    {k:<9} {n:>8,d}  {win_48:>7.1f}% {avg_48:>+12.3f}%  {win_72:>7.1f}% {avg_72:>+12.3f}%  {med_72:>+7.3f}%")

    # Overall (regardless of bucket). The "follow 24h direction" baseline.
    overall_win_72 = (pnl_72h > 0).mean() * 100
    overall_avg_72 = pnl_72h.mean()
    print(f"\n  Overall (all buckets): win 72h = {overall_win_72:.1f}%, avg PnL 72h = {overall_avg_72:+.3f}%")
    print(f"  vs random direction: would be ~50% win and ~0% avg (sanity check)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='csv_exports_node')
    ap.add_argument('--threshold', type=float, default=0.3)
    args = ap.parse_args()
    src_dir = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{args.src}'
    print("=" * 80)
    print(f"Holding-PnL test: simulate 'long if 24h up / short if 24h down', hold 72h")
    print(f"  src: {src_dir}")
    print(f"  threshold: {args.threshold}% min |24h move| to take a trade")
    print("=" * 80)

    analyze(src_dir, "CRYPTO (model: crypto v10)", CRYPTO_MODEL,
            v12.CRYPTO_SYMBOLS, 'USDT', args.threshold)
    analyze(src_dir, "STOCKS (model: stock v12)", STOCK_MODEL,
            v12.STOCK_SYMBOLS, '', args.threshold)


if __name__ == '__main__':
    main()
