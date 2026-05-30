import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score
import json

# Features (no isCrypto — separate models don't need it)
features = [
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear',
    'dStructBull', 'dStructBear',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear',
    'hStructBull', 'hStructBear',
    'atrPercent', 'volScalar', 'atrPercentile',
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

# ============================================================
# CRYPTO MODEL — 150 trees
# ============================================================
print("Training CRYPTO model (150 trees)...")
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

val_pred = crypto_model.predict(X_vc)
val_prob = crypto_model.predict_proba(X_vc)[:, 1]
print(f"  Val accuracy: {accuracy_score(y_vc, val_pred)*100:.1f}% (baseline {y_vc.mean()*100:.1f}%)")
for thresh in [0.55, 0.60, 0.65]:
    mask = val_prob >= thresh
    if mask.sum() > 0:
        print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {y_vc.values[mask].mean()*100:.1f}% WR")

# Export crypto tree JSON
booster = crypto_model.get_booster()
tree_dump = booster.get_dump(dump_format='json')
trees = [json.loads(t) for t in tree_dump]
crypto_json = {
    "features": features,
    "trees": trees,
    "version": 2,
    "market": "crypto",
    "trained_on": "BTC,ETH,SOL,XRP",
    "n_resolved": len(crypto_train) + len(crypto_val),
    "n_trees": 150
}
with open('/Users/bojanmihovilovic/CryptoLens/ml-training/ml-model-crypto.json', 'w') as f:
    json.dump(crypto_json, f)
print(f"  Exported crypto tree JSON ({len(trees)} trees)")

# CoreML
try:
    import coremltools as ct
    coreml = ct.converters.xgboost.convert(crypto_model, feature_names=features, mode='classifier')
    coreml.short_description = "MarketScope ML v2 crypto — 23 features, 150 trees, trained on BTC/ETH/SOL/XRP"
    coreml.save("/Users/bojanmihovilovic/CryptoLens/ml-training/MarketScoreML_crypto.mlmodel")
    print("  Exported CoreML model")
except Exception as e:
    print(f"  CoreML export error: {e}")

# ============================================================
# STOCK MODEL — 50 trees
# ============================================================
print("\nTraining STOCK model (50 trees)...")
stock_train, stock_val = load_resolved({
    'AAPL': '/Users/bojanmihovilovic/Downloads/AAPL (1)',
    'MSFT': '/Users/bojanmihovilovic/Downloads/MSFT (1)',
    'NVDA': '/Users/bojanmihovilovic/Downloads/NVDA (1)',
    'TSLA': '/Users/bojanmihovilovic/Downloads/TSLA (1)',
    'AMZN': '/Users/bojanmihovilovic/Downloads/AMZN (1)',
})

X_ts = stock_train[features].fillna(0); y_ts = stock_train['resolved_win']
X_vs = stock_val[features].fillna(0); y_vs = stock_val['resolved_win']

stock_model = xgb.XGBClassifier(
    max_depth=3, n_estimators=50, learning_rate=0.1,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='logloss', random_state=42
)
stock_model.fit(X_ts, y_ts, eval_set=[(X_vs, y_vs)], verbose=0)

val_pred = stock_model.predict(X_vs)
val_prob = stock_model.predict_proba(X_vs)[:, 1]
print(f"  Val accuracy: {accuracy_score(y_vs, val_pred)*100:.1f}% (baseline {y_vs.mean()*100:.1f}%)")
for thresh in [0.55, 0.60, 0.65]:
    mask = val_prob >= thresh
    if mask.sum() > 0:
        print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {y_vs.values[mask].mean()*100:.1f}% WR")

# Export stock tree JSON
booster = stock_model.get_booster()
tree_dump = booster.get_dump(dump_format='json')
trees = [json.loads(t) for t in tree_dump]
stock_json = {
    "features": features,
    "trees": trees,
    "version": 2,
    "market": "stock",
    "trained_on": "AAPL,MSFT,NVDA,TSLA,AMZN",
    "n_resolved": len(stock_train) + len(stock_val),
    "n_trees": 50
}
with open('/Users/bojanmihovilovic/CryptoLens/ml-training/ml-model-stock.json', 'w') as f:
    json.dump(stock_json, f)
print(f"  Exported stock tree JSON ({len(trees)} trees)")

# CoreML
try:
    import coremltools as ct
    coreml = ct.converters.xgboost.convert(stock_model, feature_names=features, mode='classifier')
    coreml.short_description = "MarketScope ML v2 stock — 23 features, 50 trees, trained on AAPL/MSFT/NVDA/TSLA/AMZN"
    coreml.save("/Users/bojanmihovilovic/CryptoLens/ml-training/MarketScoreML_stock.mlmodel")
    print("  Exported CoreML model")
except Exception as e:
    print(f"  CoreML export error: {e}")

print("\nDone! Files:")
print("  ml-training/ml-model-crypto.json  → worker")
print("  ml-training/ml-model-stock.json   → worker")
print("  ml-training/MarketScoreML_crypto.mlmodel → Xcode")
print("  ml-training/MarketScoreML_stock.mlmodel   → Xcode")
