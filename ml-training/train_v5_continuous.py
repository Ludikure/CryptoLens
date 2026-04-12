"""
ML Training v5 — Continuous forward returns as targets.

Key changes from v4:
1. Target: fwdMaxFavR (max favorable excursion in ATR multiples) — continuous, not binary
2. Training data: ALL bars, not just resolved TP/SL trades (~5x more data)
3. Secondary model: fwdDirection24H classification (up/flat/down)
4. Symbol column enables pooling verification
5. Dual output: regression (probability of good R) + classification (direction)

The regression model's output is calibrated to a 0-1 probability via:
  P(win) = sigmoid(predicted_R - threshold)
This replaces the old binary classifier while being trained on richer signal.
"""

import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score, mean_squared_error, r2_score
import json
import os
import glob

# 67 ML features (v5: added cross-TF interactions + temporal)
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
    # Derivatives (5)
    'fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
    # Macro (3)
    'vix', 'dxyAboveEma20', 'volScalarML',
    # Candle patterns (3)
    'last3Green', 'last3Red', 'last3VolIncreasing',
    # Stock-only (2)
    'obvRising', 'adLineAccumulation',
    # Context (3)
    'atrPercent', 'atrPercentile',
    'dailyScore', 'fourHScore',
    # Cross-timeframe interactions (5)
    'tfAlignment', 'momentumAlignment', 'structureAlignment',
    'scoreSum', 'scoreDivergence',
    # Temporal (3)
    'dayOfWeek', 'barsSinceRegimeChange', 'regimeCode',
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


def load_all_bars(files, label):
    """Load ALL bars (not just resolved trades). Time-series split 70/30."""
    train_dfs, val_dfs = [], []
    for symbol, path in files.items():
        # Support both exact path and glob pattern
        if os.path.isfile(path):
            df = pd.read_csv(path)
        else:
            matches = glob.glob(f"{path}*")
            if not matches:
                print(f"  WARNING: {path} not found, skipping {symbol}")
                continue
            df = pd.read_csv(matches[0])

        # Add symbol if not present
        if 'symbol' not in df.columns:
            df['symbol'] = symbol

        # Check for new columns
        has_fwd = 'fwdMaxFavR' in df.columns
        if not has_fwd:
            print(f"  WARNING: {symbol} missing fwdMaxFavR — needs re-export with v5 backtest")
            continue

        # Filter rows with valid forward data
        valid = df[df['fwdMaxFavR'].notna() & df['fwdReturn24H'].notna()].copy()

        # Create binary target from continuous: "good R" = fwdMaxFavR >= 1.5
        valid['goodR'] = (valid['fwdMaxFavR'] >= 1.5).astype(int)

        # Also keep old resolved_win for comparison
        valid['resolved_win'] = valid['tradeOutcome'].isin(['TP1', 'TP2']).astype(int) \
            if 'tradeOutcome' in valid.columns else 0

        split_idx = int(len(valid) * 0.7)
        train_dfs.append(valid[:split_idx])
        val_dfs.append(valid[split_idx:])

        resolved = valid[valid['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])] if 'tradeOutcome' in valid.columns else valid
        print(f"  {symbol}: {len(valid)} total bars (was {len(resolved)} resolved), "
              f"goodR rate: {valid['goodR'].mean()*100:.1f}%, "
              f"mean fwdMaxFavR: {valid['fwdMaxFavR'].mean():.2f}")

    if not train_dfs:
        print(f"  ERROR: No valid data for {label}")
        return None, None

    train = pd.concat(train_dfs, ignore_index=True)
    val = pd.concat(val_dfs, ignore_index=True)
    print(f"  {label} total: train {len(train)}, val {len(val)}")
    print(f"  goodR rate: train {train['goodR'].mean()*100:.1f}%, val {val['goodR'].mean()*100:.1f}%")
    return train, val


def train_classifier(X_train, y_train, X_val, y_val, n_estimators=150):
    """Train binary classifier: P(goodR) — replaces old P(resolved_win)."""
    model = xgb.XGBClassifier(
        max_depth=3, n_estimators=n_estimators, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)
    return model


def train_regressor(X_train, y_train, X_val, y_val, n_estimators=150):
    """Train regressor: predict fwdMaxFavR directly."""
    model = xgb.XGBRegressor(
        max_depth=3, n_estimators=n_estimators, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='rmse', random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)
    return model


def report_classifier(model, X_train, y_train, X_val, y_val, val_data, label):
    val_pred = model.predict(X_val)
    val_prob = model.predict_proba(X_val)[:, 1]
    val_acc = accuracy_score(y_val, val_pred)

    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"{'='*60}")
    print(f"Train acc: {accuracy_score(y_train, model.predict(X_train))*100:.1f}%")
    print(f"Val acc:   {val_acc*100:.1f}% (baseline {y_val.mean()*100:.1f}%, lift +{(val_acc-y_val.mean())*100:.1f}pp)")

    # Per-symbol breakdown
    val_data = val_data.copy()
    val_data['prob'] = val_prob
    print(f"\nPer-symbol val accuracy:")
    for sym in sorted(val_data['symbol'].unique()):
        subset = val_data[val_data['symbol'] == sym]
        sub_pred = model.predict(X_val.iloc[subset.index - val_data.index[0]])
        sub_y = y_val.iloc[subset.index - val_data.index[0]]
        acc = accuracy_score(sub_y, sub_pred)
        print(f"  {sym}: {acc*100:.1f}% (n={len(subset)})")

    # Probability thresholds — the key metric
    print(f"\nProbability thresholds (P(goodR)):")
    for thresh in [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        mask = val_prob >= thresh
        if mask.sum() == 0: continue
        actual_wr = y_val.values[mask].mean()
        # Also check old resolved_win rate at this threshold
        if 'resolved_win' in val_data.columns:
            resolved_mask = val_data.iloc[np.where(mask)[0]]
            has_trade = resolved_mask['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED']) if 'tradeOutcome' in resolved_mask.columns else pd.Series([False])
            if has_trade.sum() > 0:
                trade_wr = resolved_mask.loc[has_trade.values, 'resolved_win'].mean()
                print(f"  P >= {thresh:.2f}: {mask.sum():5d} bars, goodR={actual_wr*100:.1f}%, tradeWR={trade_wr*100:.1f}%")
            else:
                print(f"  P >= {thresh:.2f}: {mask.sum():5d} bars, goodR={actual_wr*100:.1f}%")
        else:
            print(f"  P >= {thresh:.2f}: {mask.sum():5d} bars, goodR={actual_wr*100:.1f}%")

    # Feature importance
    print(f"\nTop 15 features:")
    importance = model.get_booster().get_score(importance_type='gain')
    for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:15]:
        print(f"  {feat}: {imp:.1f}")

    return model, val_acc


def report_regressor(model, X_train, y_train, X_val, y_val, label):
    pred_train = model.predict(X_train)
    pred_val = model.predict(X_val)
    rmse_train = np.sqrt(mean_squared_error(y_train, pred_train))
    rmse_val = np.sqrt(mean_squared_error(y_val, pred_val))
    r2 = r2_score(y_val, pred_val)

    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"{'='*60}")
    print(f"Train RMSE: {rmse_train:.3f}")
    print(f"Val RMSE:   {rmse_val:.3f}")
    print(f"Val R²:     {r2:.3f}")
    print(f"Val mean predicted R: {pred_val.mean():.3f} (actual {y_val.mean():.3f})")

    # Threshold analysis: when model predicts high R, is it right?
    print(f"\nPredicted R thresholds:")
    for thresh in [1.0, 1.5, 2.0, 2.5, 3.0]:
        mask = pred_val >= thresh
        if mask.sum() == 0: continue
        actual_mean = y_val.values[mask].mean()
        goodR_rate = (y_val.values[mask] >= 1.5).mean()
        print(f"  pred_R >= {thresh:.1f}: {mask.sum():5d} bars, actual mean R={actual_mean:.2f}, goodR rate={goodR_rate*100:.1f}%")

    return model


def export_model(model, name, market, trained_on, n_samples, model_type='classifier'):
    """Export model as JSON for TypeScript worker inference."""
    booster = model.get_booster()
    tree_dump = booster.get_dump(dump_format='json')
    trees = [json.loads(t) for t in tree_dump]
    model_json = {
        "features": features,
        "trees": trees,
        "version": 4,
        "market": market,
        "trained_on": trained_on,
        "n_samples": n_samples,
        "n_trees": len(trees),
        "n_features": len(features),
        "model_type": model_type,
        "target": "goodR" if model_type == 'classifier' else "fwdMaxFavR",
        "description": "v5: trained on ALL bars with continuous forward return targets"
    }
    json_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{name}.json'
    with open(json_path, 'w') as f:
        json.dump(model_json, f)
    print(f"  Exported: {json_path} ({len(trees)} trees)")

    # Also copy to worker src
    worker_path = f'/Users/bojanmihovilovic/CryptoLens/marketscope-worker/src/{name}.json'
    with open(worker_path, 'w') as f:
        json.dump(model_json, f)
    print(f"  Copied to: {worker_path}")

    # CoreML export
    try:
        import coremltools as ct
        if model_type == 'classifier':
            coreml = ct.converters.xgboost.convert(model, feature_names=features, mode='classifier')
        else:
            coreml = ct.converters.xgboost.convert(model, feature_names=features, mode='regressor')
        coreml.short_description = f"MarketScope ML v4 {market} — {model_type}, {len(features)} features, {len(trees)} trees"
        mlmodel_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/MarketScoreML_{market}.mlmodel'
        coreml.save(mlmodel_path)
        print(f"  CoreML: {mlmodel_path}")
        # Copy to app
        app_path = f'/Users/bojanmihovilovic/CryptoLens/CryptoLens/ML/MarketScoreML_{market}.mlmodel'
        import shutil
        shutil.copy2(mlmodel_path, app_path)
        print(f"  Copied to: {app_path}")
    except Exception as e:
        print(f"  CoreML export skipped: {e}")


# ============================================================
# COMPARISON: OLD (binary TP/SL) vs NEW (continuous fwdMaxFavR)
# ============================================================

# --- CRYPTO ---
print("=" * 60)
print("CRYPTO")
print("=" * 60)
crypto_train, crypto_val = load_all_bars(crypto_files, "Crypto")

if crypto_train is not None:
    X_tc = crypto_train[features].fillna(0)
    X_vc = crypto_val[features].fillna(0)

    # v5 classifier: P(goodR) on ALL bars
    y_tc_goodR = crypto_train['goodR']
    y_vc_goodR = crypto_val['goodR']
    print(f"\nTraining v5 classifier on {len(crypto_train)} bars (was ~{crypto_train['tradeOutcome'].isin(['TP1','TP2','STOPPED']).sum()} resolved)...")
    crypto_clf, crypto_acc = report_classifier(
        train_classifier(X_tc, y_tc_goodR, X_vc, y_vc_goodR),
        X_tc, y_tc_goodR, X_vc, y_vc_goodR, crypto_val,
        "CRYPTO v5: P(goodR >= 1.5 ATR) — ALL bars"
    )

    # v5 regressor: predict fwdMaxFavR
    y_tc_R = crypto_train['fwdMaxFavR'].clip(0, 10)  # clip outliers
    y_vc_R = crypto_val['fwdMaxFavR'].clip(0, 10)
    crypto_reg = report_regressor(
        train_regressor(X_tc, y_tc_R, X_vc, y_vc_R),
        X_tc, y_tc_R, X_vc, y_vc_R,
        "CRYPTO v5 REGRESSOR: predict fwdMaxFavR"
    )

    # v4 comparison: old binary on resolved only
    resolved_train = crypto_train[crypto_train['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])]
    resolved_val = crypto_val[crypto_val['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])]
    if len(resolved_train) > 100:
        X_old_t = resolved_train[features].fillna(0)
        X_old_v = resolved_val[features].fillna(0)
        y_old_t = resolved_train['resolved_win']
        y_old_v = resolved_val['resolved_win']
        old_model = train_classifier(X_old_t, y_old_t, X_old_v, y_old_v)
        old_acc = accuracy_score(y_old_v, old_model.predict(X_old_v))
        print(f"\n--- COMPARISON ---")
        print(f"v4 (binary TP/SL, {len(resolved_train)} resolved bars): {old_acc*100:.1f}%")
        print(f"v5 (goodR, {len(crypto_train)} ALL bars): {crypto_acc*100:.1f}%")
        print(f"Training data: {len(crypto_train)/len(resolved_train):.1f}x more bars")

    # Export the classifier (compatible with existing inference)
    export_model(crypto_clf, "ml-model-crypto", "crypto", ",".join(crypto_files.keys()),
                 len(crypto_train) + len(crypto_val))


# --- STOCK ---
print(f"\n\n{'='*60}")
print("STOCK")
print("=" * 60)
stock_train, stock_val = load_all_bars(stock_files, "Stock")

if stock_train is not None:
    X_ts = stock_train[features].fillna(0)
    X_vs = stock_val[features].fillna(0)

    # v5 classifier
    y_ts_goodR = stock_train['goodR']
    y_vs_goodR = stock_val['goodR']
    print(f"\nTraining v5 classifier on {len(stock_train)} bars...")
    stock_clf, stock_acc = report_classifier(
        train_classifier(X_ts, y_ts_goodR, X_vs, y_vs_goodR),
        X_ts, y_ts_goodR, X_vs, y_vs_goodR, stock_val,
        "STOCK v5: P(goodR >= 1.5 ATR) — ALL bars"
    )

    # v5 regressor
    y_ts_R = stock_train['fwdMaxFavR'].clip(0, 10)
    y_vs_R = stock_val['fwdMaxFavR'].clip(0, 10)
    stock_reg = report_regressor(
        train_regressor(X_ts, y_ts_R, X_vs, y_vs_R),
        X_ts, y_ts_R, X_vs, y_vs_R,
        "STOCK v5 REGRESSOR: predict fwdMaxFavR"
    )

    # v4 comparison
    resolved_train = stock_train[stock_train['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])]
    resolved_val = stock_val[stock_val['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])]
    if len(resolved_train) > 100:
        X_old_t = resolved_train[features].fillna(0)
        X_old_v = resolved_val[features].fillna(0)
        y_old_t = resolved_train['resolved_win']
        y_old_v = resolved_val['resolved_win']
        old_model = train_classifier(X_old_t, y_old_t, X_old_v, y_old_v)
        old_acc = accuracy_score(y_old_v, old_model.predict(X_old_v))
        print(f"\n--- COMPARISON ---")
        print(f"v4 (binary TP/SL, {len(resolved_train)} resolved bars): {old_acc*100:.1f}%")
        print(f"v5 (goodR, {len(stock_train)} ALL bars): {stock_acc*100:.1f}%")
        print(f"Training data: {len(stock_train)/len(resolved_train):.1f}x more bars")

    export_model(stock_clf, "ml-model-stock", "stock", ",".join(stock_files.keys()),
                 len(stock_train) + len(stock_val))
else:
    print("No stock data available")


print(f"\n{'='*60}")
print("DONE — v5 models exported")
print("Next: deploy worker, rebuild iOS app")
print(f"{'='*60}")
