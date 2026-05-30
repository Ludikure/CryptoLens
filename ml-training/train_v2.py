import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score
import json
import os

# Load all CSVs
crypto_files = {
    'BTC': '/Users/bojanmihovilovic/Downloads/BTC',
    'ETH': '/Users/bojanmihovilovic/Downloads/ETH',
    'SOL': '/Users/bojanmihovilovic/Downloads/SOL',
    'XRP': '/Users/bojanmihovilovic/Downloads/XRP',
}
stock_files = {
    'AAPL': '/Users/bojanmihovilovic/Downloads/AAPL',
    'MSFT': '/Users/bojanmihovilovic/Downloads/MSFT',
    'NVDA': '/Users/bojanmihovilovic/Downloads/NVDA',
    'TSLA': '/Users/bojanmihovilovic/Downloads/TSLA',
    'AMZN': '/Users/bojanmihovilovic/Downloads/AMZN',
}

dfs = []
for symbol, path in {**crypto_files, **stock_files}.items():
    df = pd.read_csv(path)
    df['symbol'] = symbol
    dfs.append(df)
    print(f"  {symbol}: {len(df)} rows, isCrypto={df['isCrypto'].iloc[0]}")

all_data = pd.concat(dfs, ignore_index=True)
print(f"\nTotal rows: {len(all_data)}")
print(f"Crypto: {int(all_data['isCrypto'].sum())}, Stock: {int((1-all_data['isCrypto']).sum())}")

# Target: resolved win (TP1 or TP2 hit)
all_data['resolved_win'] = all_data['tradeOutcome'].isin(['TP1', 'TP2']).astype(int)

# Filter to resolved trades only (exclude EXPIRED, NONE, NaN)
resolved = all_data[all_data['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])].copy()
print(f"Resolved trades: {len(resolved)} ({resolved['resolved_win'].mean()*100:.1f}% baseline WR)")

crypto_resolved = resolved[resolved['isCrypto'] == 1]
stock_resolved = resolved[resolved['isCrypto'] == 0]
print(f"  Crypto resolved: {len(crypto_resolved)} ({crypto_resolved['resolved_win'].mean()*100:.1f}% baseline)")
print(f"  Stock resolved: {len(stock_resolved)} ({stock_resolved['resolved_win'].mean()*100:.1f}% baseline)")

features = [
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear',
    'dStructBull', 'dStructBear',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear',
    'hStructBull', 'hStructBear',
    'atrPercent', 'volScalar', 'atrPercentile',
    'dailyScore', 'fourHScore',
    'isCrypto'
]

X = resolved[features].fillna(0)
y = resolved['resolved_win']

# Time-series split — 70/30
split_idx = int(len(X) * 0.7)
X_train, X_val = X[:split_idx], X[split_idx:]
y_train, y_val = y[:split_idx], y[split_idx:]

print(f"\nTrain: {len(X_train)} rows, Val: {len(X_val)} rows")
print(f"Train baseline WR: {y_train.mean()*100:.1f}%")
print(f"Val baseline WR: {y_val.mean()*100:.1f}%")

model = xgb.XGBClassifier(
    max_depth=3,
    n_estimators=150,
    learning_rate=0.1,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=10,
    eval_metric='logloss',
    random_state=42
)

model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=10)

# Results
val_pred = model.predict(X_val)
val_prob = model.predict_proba(X_val)[:, 1]

train_acc = accuracy_score(y_train, model.predict(X_train))
val_acc = accuracy_score(y_val, val_pred)
print(f"\n{'='*60}")
print(f"RESULTS")
print(f"{'='*60}")
print(f"Train accuracy: {train_acc*100:.1f}%")
print(f"Val accuracy:   {val_acc*100:.1f}%")

# Per-market breakdown
val_data = resolved.iloc[split_idx:].copy()
val_data['pred'] = val_pred
val_data['prob'] = val_prob

print(f"\nPer-market breakdown:")
for market, label in [(1, 'Crypto'), (0, 'Stock')]:
    subset = val_data[val_data['isCrypto'] == market]
    if len(subset) == 0: continue
    acc = accuracy_score(subset['resolved_win'], subset['pred'])
    baseline = subset['resolved_win'].mean()
    print(f"  {label}: {acc*100:.1f}% (baseline {baseline*100:.1f}%, lift +{(acc-baseline)*100:.1f}pp, n={len(subset)})")

# Per-symbol breakdown
print(f"\nPer-symbol breakdown:")
for sym in val_data['symbol'].unique():
    subset = val_data[val_data['symbol'] == sym]
    acc = accuracy_score(subset['resolved_win'], subset['pred'])
    baseline = subset['resolved_win'].mean()
    print(f"  {sym}: {acc*100:.1f}% (baseline {baseline*100:.1f}%, lift +{(acc-baseline)*100:.1f}pp, n={len(subset)})")

# Probability thresholds
print(f"\nProbability filtering:")
for thresh in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
    mask = val_prob >= thresh
    if mask.sum() == 0: continue
    wr = y_val.values[mask].mean()
    print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {wr*100:.1f}% WR")

# Per-market probability thresholds
print(f"\nProbability filtering (Crypto only):")
crypto_mask = val_data['isCrypto'] == 1
for thresh in [0.50, 0.55, 0.60, 0.65, 0.70]:
    mask = (val_data['prob'] >= thresh) & crypto_mask
    if mask.sum() == 0: continue
    wr = val_data.loc[mask, 'resolved_win'].mean()
    print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {wr*100:.1f}% WR")

print(f"\nProbability filtering (Stock only):")
stock_mask = val_data['isCrypto'] == 0
for thresh in [0.50, 0.55, 0.60, 0.65, 0.70]:
    mask = (val_data['prob'] >= thresh) & stock_mask
    if mask.sum() == 0: continue
    wr = val_data.loc[mask, 'resolved_win'].mean()
    print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {wr*100:.1f}% WR")

# Feature importance
print(f"\nTop features:")
importance = model.get_booster().get_score(importance_type='gain')
for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:15]:
    print(f"  {feat}: {imp:.1f}")

if 'isCrypto' in importance:
    rank = sorted(importance.values(), reverse=True).index(importance['isCrypto']) + 1
    print(f"\nisCrypto importance rank: {rank}/{len(importance)}")

# Decision gate
print(f"\n{'='*60}")
print(f"DECISION GATE")
print(f"{'='*60}")
val_baseline = y_val.mean()
stock_val = val_data[val_data['isCrypto'] == 0]
stock_acc = accuracy_score(stock_val['resolved_win'], stock_val['pred']) if len(stock_val) > 0 else 0
stock_baseline = stock_val['resolved_win'].mean() if len(stock_val) > 0 else 0
stock_lift = stock_acc - stock_baseline

print(f"Combined val accuracy: {val_acc*100:.1f}%")
print(f"Stock lift: +{stock_lift*100:.1f}pp")

if val_acc > 0.57 and stock_lift > 0.03:
    print("→ DEPLOY COMBINED MODEL")
elif val_acc > 0.57 and stock_lift < 0.02:
    print("→ isCrypto not helping stocks — consider separate models")
else:
    print("→ Check numbers — may need separate models")

# Export CoreML
print(f"\n{'='*60}")
print(f"EXPORTING MODEL")
print(f"{'='*60}")

# Save XGBoost model
model.save_model('/Users/bojanmihovilovic/CryptoLens/ml-training/model_v2.json')
print("Saved XGBoost model to model_v2.json")

# Export tree JSON for worker
booster = model.get_booster()
tree_dump = booster.get_dump(dump_format='json')
trees = [json.loads(t) for t in tree_dump]

model_json = {
    "features": features,
    "trees": trees,
    "version": 2,
    "trained_on": "BTC,ETH,SOL,XRP,AAPL,MSFT,NVDA,TSLA,AMZN",
    "n_resolved": len(resolved)
}

with open('/Users/bojanmihovilovic/CryptoLens/ml-training/ml-model-v2.json', 'w') as f:
    json.dump(model_json, f)
print(f"Saved worker tree JSON ({len(trees)} trees, {len(features)} features)")

# CoreML conversion
try:
    import coremltools as ct
    coreml_model = ct.converters.xgboost.convert(
        model,
        feature_names=features,
        mode='classifier'
    )
    coreml_model.short_description = "MarketScope ML v2 — crypto+stock, 24 features incl isCrypto"
    coreml_model.save("/Users/bojanmihovilovic/CryptoLens/ml-training/MarketScoreML_v2.mlmodel")
    print("Saved CoreML model")
except ImportError:
    print("coremltools not installed — skipping CoreML export")
    print("Run: pip install coremltools && python -c \"import coremltools as ct; ...\"")

print("\nDone!")
