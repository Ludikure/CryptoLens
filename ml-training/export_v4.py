import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score
import json

# 51 ML features
features = [
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear', 'dStructBull', 'dStructBear',
    'dStochK', 'dStochCross', 'dMacdCross', 'dDivergence', 'dEma20Rising',
    'dBBPercentB', 'dBBSqueeze', 'dBBBandwidth', 'dVolumeRatio', 'dAboveVwap',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear', 'hStructBull', 'hStructBear',
    'hStochK', 'hStochCross', 'hMacdCross', 'hDivergence', 'hEma20Rising',
    'hBBPercentB', 'hBBSqueeze', 'hBBBandwidth', 'hVolumeRatio', 'hAboveVwap',
    'eRsi', 'eEmaCross', 'eStochK', 'eMacdHist',
    'fundingSignal', 'oiSignal', 'takerSignal', 'crowdingSignal', 'derivativesCombined',
    'vix', 'dxyAboveEma20', 'volScalarML',
    'last3Green', 'last3Red', 'last3VolIncreasing',
    'obvRising', 'adLineAccumulation',
    'atrPercent', 'atrPercentile',
    'dailyScore', 'fourHScore',
]

def load_resolved(files):
    train_dfs, val_dfs = [], []
    for symbol, path in files.items():
        df = pd.read_csv(path)
        df['symbol'] = symbol
        df['resolved_win'] = df['tradeOutcome'].isin(['TP1', 'TP2']).astype(int)
        resolved = df[df['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])].copy()
        split_idx = int(len(resolved) * 0.7)
        train_dfs.append(resolved[:split_idx])
        val_dfs.append(resolved[split_idx:])
    return pd.concat(train_dfs, ignore_index=True), pd.concat(val_dfs, ignore_index=True)

def export_model(model, name, market, trained_on, n_resolved):
    booster = model.get_booster()
    tree_dump = booster.get_dump(dump_format='json')
    trees = [json.loads(t) for t in tree_dump]
    model_json = {
        "features": features,
        "trees": trees,
        "version": 3,
        "market": market,
        "trained_on": trained_on,
        "n_resolved": n_resolved,
        "n_trees": len(trees),
        "n_features": len(features)
    }
    json_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{name}.json'
    with open(json_path, 'w') as f:
        json.dump(model_json, f)
    print(f"  Tree JSON: {json_path} ({len(trees)} trees, {len(features)} features)")

    try:
        import coremltools as ct
        coreml = ct.converters.xgboost.convert(model, feature_names=features, mode='classifier')
        coreml.short_description = f"MarketScope ML v3 {market} — {len(features)} features, {len(trees)} trees"
        mlmodel_path = f'/Users/bojanmihovilovic/CryptoLens/ml-training/{name}.mlmodel'
        coreml.save(mlmodel_path)
        print(f"  CoreML: {mlmodel_path}")
    except Exception as e:
        print(f"  CoreML export error: {e}")

# CRYPTO — 150 trees
print("Training CRYPTO model (150 trees, 51 features)...")
crypto_train, crypto_val = load_resolved({
    'BTC': '/Users/bojanmihovilovic/Downloads/BTC',
    'ETH': '/Users/bojanmihovilovic/Downloads/ETH',
    'SOL': '/Users/bojanmihovilovic/Downloads/SOL',
    'XRP': '/Users/bojanmihovilovic/Downloads/XRP',
})
X_tc = crypto_train[features].fillna(0); y_tc = crypto_train['resolved_win']
X_vc = crypto_val[features].fillna(0); y_vc = crypto_val['resolved_win']

crypto_model = xgb.XGBClassifier(
    max_depth=3, n_estimators=150, learning_rate=0.1,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='logloss', random_state=42
)
crypto_model.fit(X_tc, y_tc, eval_set=[(X_vc, y_vc)], verbose=0)

val_prob = crypto_model.predict_proba(X_vc)[:, 1]
print(f"  Val: {accuracy_score(y_vc, crypto_model.predict(X_vc))*100:.1f}%")
for t in [0.60, 0.65, 0.70]:
    m = val_prob >= t
    if m.sum(): print(f"  P>={t:.2f}: {m.sum()} trades, {y_vc.values[m].mean()*100:.1f}% WR")

export_model(crypto_model, "ml-model-crypto", "crypto", "BTC,ETH,SOL,XRP",
             len(crypto_train) + len(crypto_val))

# STOCK — 150 trees (better coverage at probability thresholds)
print("\nTraining STOCK model (150 trees, 51 features)...")
stock_train, stock_val = load_resolved({
    'AAPL': '/Users/bojanmihovilovic/Downloads/AAPL',
    'MSFT': '/Users/bojanmihovilovic/Downloads/MSFT',
    'NVDA': '/Users/bojanmihovilovic/Downloads/NVDA',
    'TSLA': '/Users/bojanmihovilovic/Downloads/TSLA',
    'AMZN': '/Users/bojanmihovilovic/Downloads/AMZN',
    'GOOG': '/Users/bojanmihovilovic/Downloads/GOOG',
    'META': '/Users/bojanmihovilovic/Downloads/META',
    'JPM': '/Users/bojanmihovilovic/Downloads/JPM',
    'UNH': '/Users/bojanmihovilovic/Downloads/UNH',
    'XOM': '/Users/bojanmihovilovic/Downloads/XOM',
    'HD': '/Users/bojanmihovilovic/Downloads/HD',
    'MA': '/Users/bojanmihovilovic/Downloads/MA',
})
X_ts = stock_train[features].fillna(0); y_ts = stock_train['resolved_win']
X_vs = stock_val[features].fillna(0); y_vs = stock_val['resolved_win']

stock_model = xgb.XGBClassifier(
    max_depth=3, n_estimators=150, learning_rate=0.1,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='logloss', random_state=42
)
stock_model.fit(X_ts, y_ts, eval_set=[(X_vs, y_vs)], verbose=0)

val_prob = stock_model.predict_proba(X_vs)[:, 1]
print(f"  Val: {accuracy_score(y_vs, stock_model.predict(X_vs))*100:.1f}%")
for t in [0.60, 0.65, 0.70]:
    m = val_prob >= t
    if m.sum(): print(f"  P>={t:.2f}: {m.sum()} trades, {y_vs.values[m].mean()*100:.1f}% WR")

export_model(stock_model, "ml-model-stock", "stock",
             "AAPL,MSFT,NVDA,TSLA,AMZN,GOOG,META,JPM,UNH,XOM,HD,MA",
             len(stock_train) + len(stock_val))

print("\nDone!")
