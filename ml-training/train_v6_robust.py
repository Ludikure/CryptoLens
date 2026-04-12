"""
ML Training v6 — Robust evaluation with honest accuracy metrics.

Key changes from v5:
1. Purged time-series CV: 48-bar gap between train/val to prevent autocorrelation leak
2. Daily downsampling: 1 bar per daily close to remove ~6x duplication of daily features
3. Walk-forward validation: 3 expanding-window folds instead of single split
4. New features: raw derivatives (fundingRateRaw, oiChangePct, takerRatioRaw, longPctRaw)
   + rate-of-change (dRsiDelta, dAdxDelta, hRsiDelta, hAdxDelta, hMacdHistDelta)
5. Reports both "inflated" (all bars) and "honest" (downsampled + purged) accuracy
"""

import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score, mean_squared_error, r2_score
import json
import os
import glob

# 80 ML features (v6b: +4 sentiment/cross-asset)
features = [
    # Daily core (9)
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear', 'dStructBull', 'dStructBear',
    # Daily momentum (5)
    'dStochK', 'dStochCross', 'dMacdCross', 'dDivergence', 'dEma20Rising',
    # Daily vol/volume (5)
    'dBBPercentB', 'dBBSqueeze', 'dBBBandwidth', 'dVolumeRatio', 'dAboveVwap',
    # 4H core (9)
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear', 'hStructBull', 'hStructBear',
    # 4H momentum (5)
    'hStochK', 'hStochCross', 'hMacdCross', 'hDivergence', 'hEma20Rising',
    # 4H vol/volume (5)
    'hBBPercentB', 'hBBSqueeze', 'hBBBandwidth', 'hVolumeRatio', 'hAboveVwap',
    # 1H entry (4)
    'eRsi', 'eEmaCross', 'eStochK', 'eMacdHist',
    # Derivatives discretized (5)
    'fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
    # Derivatives raw continuous (4)
    'fundingRateRaw', 'oiChangePct', 'takerRatioRaw', 'longPctRaw',
    # Macro (3)
    'vix', 'dxyAboveEma20', 'volScalarML',
    # Candle patterns (3)
    'last3Green', 'last3Red', 'last3VolIncreasing',
    # Stock-only (2)
    'obvRising', 'adLineAccumulation',
    # Context (4)
    'atrPercent', 'atrPercentile',
    'dailyScore', 'fourHScore',
    # Cross-timeframe interactions (5)
    'tfAlignment', 'momentumAlignment', 'structureAlignment',
    'scoreSum', 'scoreDivergence',
    # Temporal (3)
    'dayOfWeek', 'barsSinceRegimeChange', 'regimeCode',
    # Rate-of-change (5)
    'dRsiDelta', 'dAdxDelta', 'hRsiDelta', 'hAdxDelta', 'hMacdHistDelta',
    # Sentiment (2)
    'fearGreedIndex', 'fearGreedZone',
    # Cross-asset crypto (2)
    'ethBtcRatio', 'ethBtcDelta6',
]

DOWNLOADS = '/Users/bojanmihovilovic/Downloads'

crypto_files = {
    'BTC': f'{DOWNLOADS}/BTCUSDT.csv',
    'ETH': f'{DOWNLOADS}/ETHUSDT.csv',
    'SOL': f'{DOWNLOADS}/SOLUSDT.csv',
    'XRP': f'{DOWNLOADS}/XRPUSDT.csv',
}
stock_files = {
    'AAPL': f'{DOWNLOADS}/AAPL.csv',
    'MSFT': f'{DOWNLOADS}/MSFT.csv',
    'NVDA': f'{DOWNLOADS}/NVDA.csv',
    'TSLA': f'{DOWNLOADS}/TSLA.csv',
    'AMZN': f'{DOWNLOADS}/AMZN.csv',
    'GOOGL': f'{DOWNLOADS}/GOOGL.csv',
    'META': f'{DOWNLOADS}/META.csv',
    'JPM': f'{DOWNLOADS}/JPM.csv',
    'UNH': f'{DOWNLOADS}/UNH.csv',
    'ABBV': f'{DOWNLOADS}/ABBV.csv',
    'HD': f'{DOWNLOADS}/HD.csv',
    'MA': f'{DOWNLOADS}/MA.csv',
}


def load_symbol(path, symbol):
    """Load a single symbol CSV."""
    if os.path.isfile(path):
        df = pd.read_csv(path)
    else:
        matches = glob.glob(f"{path}*")
        if not matches:
            print(f"  WARNING: {path} not found, skipping {symbol}")
            return None
        df = pd.read_csv(matches[0])

    if 'symbol' not in df.columns:
        df['symbol'] = symbol

    if 'fwdMaxFavR' not in df.columns:
        print(f"  WARNING: {symbol} missing fwdMaxFavR — needs re-export")
        return None

    valid = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()
    valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)
    valid['resolved_win'] = valid['tradeOutcome'].isin(['TP1', 'TP2']).astype(int) \
        if 'tradeOutcome' in valid.columns else 0

    # Fill missing new features with defaults
    for feat in features:
        if feat not in valid.columns:
            default = 1.0 if feat == 'takerRatioRaw' else 50.0 if feat == 'longPctRaw' else 0.0
            valid[feat] = default

    return valid


def downsample_daily(df):
    """Keep only 1 bar per daily close (last 4H bar of each day).
    Removes ~5x redundancy from repeated daily features."""
    df = df.copy()
    df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.date
    # Keep the last 4H bar of each day per symbol
    return df.groupby(['symbol', 'date']).tail(1).reset_index(drop=True)


def purged_split(df, train_frac=0.7, purge_bars=48):
    """Time-series split with purge gap to prevent autocorrelation leak."""
    split_idx = int(len(df) * train_frac)
    train = df[:split_idx]
    # Skip purge_bars after train end
    val_start = split_idx + purge_bars
    if val_start >= len(df):
        val_start = split_idx  # fallback if data too small
    val = df[val_start:]
    return train, val


def walk_forward_cv(df, n_folds=3, purge_bars=48):
    """Expanding-window walk-forward cross-validation.
    Fold 1: train on first 40%, val on 40-55% (purged)
    Fold 2: train on first 55%, val on 55-70% (purged)
    Fold 3: train on first 70%, val on 70-100% (purged)
    """
    n = len(df)
    folds = []
    for i in range(n_folds):
        train_end = int(n * (0.4 + i * 0.15))  # 40%, 55%, 70%
        val_start = train_end + purge_bars
        val_end = int(n * (0.55 + i * 0.15))    # 55%, 70%, 100%
        if i == n_folds - 1:
            val_end = n  # last fold uses all remaining data
        if val_start >= val_end:
            continue
        folds.append((df[:train_end], df[val_start:val_end]))
    return folds


def load_all(files, label, downsample=True):
    """Load all symbols, optionally downsample, return per-symbol list."""
    all_dfs = []
    for symbol, path in files.items():
        df = load_symbol(path, symbol)
        if df is None:
            continue
        total = len(df)
        if downsample:
            df = downsample_daily(df)
        resolved = df[df['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])] if 'tradeOutcome' in df.columns else df
        print(f"  {symbol}: {total} raw → {len(df)} downsampled, "
              f"goodR rate: {df['goodR'].mean()*100:.1f}%, "
              f"mean fwdMaxFavR: {df['fwdMaxFavR'].mean():.2f}")
        all_dfs.append(df)

    if not all_dfs:
        print(f"  ERROR: No valid data for {label}")
        return None
    combined = pd.concat(all_dfs, ignore_index=True)
    combined = combined.sort_values('timestamp').reset_index(drop=True)
    print(f"  {label} total: {len(combined)} bars (downsampled)")
    return combined


def compute_sample_weights(timestamps):
    """Weight recent bars higher: last 1 year 3x, last 2 years 2x, older 1x."""
    now = timestamps.max()
    one_year = now - 365 * 86400
    two_years = now - 2 * 365 * 86400
    weights = np.ones(len(timestamps))
    weights[timestamps >= two_years] = 2.0
    weights[timestamps >= one_year] = 3.0
    return weights


def train_classifier(X_train, y_train, X_val, y_val, n_estimators=150, sample_weight=None):
    model = xgb.XGBClassifier(
        max_depth=3, n_estimators=n_estimators, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0,
              sample_weight=sample_weight)
    return model


def report(model, X_val, y_val, val_data, label):
    val_pred = model.predict(X_val)
    val_prob = model.predict_proba(X_val)[:, 1]
    val_acc = accuracy_score(y_val, val_pred)
    baseline = y_val.mean()

    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"{'='*60}")
    print(f"Val acc: {val_acc*100:.1f}% (baseline {baseline*100:.1f}%, lift +{(val_acc-baseline)*100:.1f}pp)")

    # Per-symbol breakdown
    if 'symbol' in val_data.columns:
        print(f"\nPer-symbol val accuracy:")
        for sym in sorted(val_data['symbol'].unique()):
            mask = val_data['symbol'] == sym
            if mask.sum() == 0:
                continue
            sub_X = X_val[mask.values]
            sub_y = y_val[mask.values]
            sub_pred = model.predict(sub_X)
            acc = accuracy_score(sub_y, sub_pred)
            print(f"  {sym}: {acc*100:.1f}% (n={mask.sum()})")

    # Probability thresholds
    print(f"\nProbability thresholds:")
    for thresh in [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        mask = val_prob >= thresh
        if mask.sum() == 0:
            continue
        actual_wr = y_val.values[mask].mean()
        print(f"  P >= {thresh:.2f}: {mask.sum():5d} bars, goodR={actual_wr*100:.1f}%")

    # Feature importance
    print(f"\nTop 20 features:")
    importance = model.get_booster().get_score(importance_type='gain')
    for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:20]:
        print(f"  {feat}: {imp:.1f}")

    return val_acc


def walk_forward_report(data, label):
    """Run walk-forward CV and report average honest accuracy."""
    folds = walk_forward_cv(data)
    accs = []
    print(f"\n{'='*60}")
    print(f"WALK-FORWARD CV: {label} ({len(folds)} folds)")
    print(f"{'='*60}")

    for i, (train_df, val_df) in enumerate(folds):
        X_t = train_df[features].fillna(0)
        y_t = train_df['goodR']
        X_v = val_df[features].fillna(0)
        y_v = val_df['goodR']
        w_t = compute_sample_weights(train_df['timestamp'].values)

        model = train_classifier(X_t, y_t, X_v, y_v, sample_weight=w_t)
        pred = model.predict(X_v)
        acc = accuracy_score(y_v, pred)
        baseline = y_v.mean()
        accs.append(acc)
        print(f"  Fold {i+1}: train {len(train_df)}, val {len(val_df)}, "
              f"acc {acc*100:.1f}% (baseline {baseline*100:.1f}%, lift +{(acc-baseline)*100:.1f}pp)")

    mean_acc = np.mean(accs)
    std_acc = np.std(accs)
    print(f"\n  Walk-forward mean: {mean_acc*100:.1f}% ± {std_acc*100:.1f}%")
    return mean_acc


def export_model(model, name, market, trained_on, n_samples):
    """Export model as JSON + CoreML."""
    booster = model.get_booster()
    tree_dump = booster.get_dump(dump_format='json')
    trees = [json.loads(t) for t in tree_dump]
    model_json = {
        "features": features,
        "trees": trees,
        "version": 6,
        "market": market,
        "trained_on": trained_on,
        "n_samples": n_samples,
        "n_trees": len(trees),
        "n_features": len(features),
        "model_type": "classifier",
        "target": "goodR",
        "description": "v6b: +fear/greed, ETH/BTC, sample weighting, purged CV, daily downsample"
    }
    json_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{name}.json'
    with open(json_path, 'w') as f:
        json.dump(model_json, f)
    print(f"  Exported: {json_path} ({len(trees)} trees)")

    worker_path = f'/Users/bojanmihovilovic/CryptoLens/marketscope-worker/src/{name}.json'
    with open(worker_path, 'w') as f:
        json.dump(model_json, f)
    print(f"  Copied to: {worker_path}")

    try:
        import coremltools as ct
        coreml = ct.converters.xgboost.convert(model, feature_names=features, mode='classifier')
        coreml.short_description = f"MarketScope ML v6 {market} — {len(features)} features, {len(trees)} trees"
        mlmodel_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/MarketScoreML_{market}.mlmodel'
        coreml.save(mlmodel_path)
        print(f"  CoreML: {mlmodel_path}")
        import shutil
        app_path = f'/Users/bojanmihovilovic/CryptoLens/CryptoLens/ML/MarketScoreML_{market}.mlmodel'
        shutil.copy2(mlmodel_path, app_path)
        print(f"  Copied to: {app_path}")
    except Exception as e:
        print(f"  CoreML export skipped: {e}")


def train_and_report(data, market_label):
    """Full training pipeline for one market: honest eval + final model."""
    # 1. Walk-forward CV for honest accuracy estimate
    wf_acc = walk_forward_report(data, f"{market_label} (downsampled + purged)")

    # 2. Final model: train on 70% with purge gap + sample weighting
    train_df, val_df = purged_split(data)
    X_t = train_df[features].fillna(0)
    y_t = train_df['goodR']
    X_v = val_df[features].fillna(0)
    y_v = val_df['goodR']
    w_t = compute_sample_weights(train_df['timestamp'].values)

    model = train_classifier(X_t, y_t, X_v, y_v, sample_weight=w_t)
    final_acc = report(model, X_v, y_v, val_df, f"{market_label} FINAL (purged 70/30, weighted)")

    # 3. Also report unweighted for comparison
    model_nw = train_classifier(X_t, y_t, X_v, y_v)
    nw_acc = accuracy_score(y_v, model_nw.predict(X_v))

    print(f"\n--- {market_label} ACCURACY COMPARISON ---")
    print(f"  Unweighted (purged 70/30):      {nw_acc*100:.1f}%")
    print(f"  Weighted (purged 70/30):        {final_acc*100:.1f}%")
    print(f"  Walk-forward mean (honest):     {wf_acc*100:.1f}%")

    return model, wf_acc


# ============================================================
# MAIN
# ============================================================

print(f"Feature count: {len(features)}\n")

# --- CRYPTO ---
print("=" * 60)
print("CRYPTO")
print("=" * 60)
crypto_data = load_all(crypto_files, "Crypto", downsample=True)

if crypto_data is not None:
    crypto_model, crypto_wf = train_and_report(crypto_data, "CRYPTO")
    export_model(crypto_model, "ml-model-crypto", "crypto",
                 ",".join(crypto_files.keys()), len(crypto_data))


# --- STOCK ---
print(f"\n\n{'='*60}")
print("STOCK")
print("=" * 60)
stock_data = load_all(stock_files, "Stock", downsample=True)

if stock_data is not None:
    stock_model, stock_wf = train_and_report(stock_data, "STOCK")
    export_model(stock_model, "ml-model-stock", "stock",
                 ",".join(stock_files.keys()), len(stock_data))
else:
    print("No stock data available")


print(f"\n{'='*60}")
print("DONE — v6 models exported")
print("Next: re-export CSVs from app with new features, then retrain")
print(f"{'='*60}")
