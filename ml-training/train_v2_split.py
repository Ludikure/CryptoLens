import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score
import json

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

def load_and_split(files, label):
    """Per-symbol 70/30 time-series split, then combine."""
    train_dfs, val_dfs = [], []
    for symbol, path in files.items():
        df = pd.read_csv(path)
        df['symbol'] = symbol
        df['resolved_win'] = df['tradeOutcome'].isin(['TP1', 'TP2']).astype(int)
        resolved = df[df['tradeOutcome'].isin(['TP1', 'TP2', 'STOPPED'])].copy()

        split_idx = int(len(resolved) * 0.7)
        train_dfs.append(resolved[:split_idx])
        val_dfs.append(resolved[split_idx:])
        print(f"  {symbol}: {len(resolved)} resolved (train {split_idx}, val {len(resolved)-split_idx}), baseline {resolved['resolved_win'].mean()*100:.1f}%")

    train = pd.concat(train_dfs, ignore_index=True)
    val = pd.concat(val_dfs, ignore_index=True)
    print(f"  {label} total: train {len(train)}, val {len(val)}")
    return train, val

def train_model(X_train, y_train, X_val, y_val, n_estimators=150):
    model = xgb.XGBClassifier(
        max_depth=3,
        n_estimators=n_estimators,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=10,
        eval_metric='logloss',
        random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)
    return model

def report(model, X_train, y_train, X_val, y_val, val_data, label):
    val_pred = model.predict(X_val)
    val_prob = model.predict_proba(X_val)[:, 1]

    print(f"\n{'='*60}")
    print(f"{label} MODEL")
    print(f"{'='*60}")
    print(f"Train: {accuracy_score(y_train, model.predict(X_train))*100:.1f}%")
    print(f"Val:   {accuracy_score(y_val, val_pred)*100:.1f}% (baseline {y_val.mean()*100:.1f}%)")
    print(f"Lift:  +{(accuracy_score(y_val, val_pred) - y_val.mean())*100:.1f}pp")

    val_data = val_data.copy()
    val_data['pred'] = val_pred
    val_data['prob'] = val_prob

    print(f"\nPer-symbol:")
    for sym in sorted(val_data['symbol'].unique()):
        subset = val_data[val_data['symbol'] == sym]
        acc = accuracy_score(subset['resolved_win'], subset['pred'])
        baseline = subset['resolved_win'].mean()
        print(f"  {sym}: {acc*100:.1f}% (baseline {baseline*100:.1f}%, lift +{(acc-baseline)*100:.1f}pp, n={len(subset)})")

    print(f"\nProbability thresholds:")
    for thresh in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        mask = val_prob >= thresh
        if mask.sum() == 0: continue
        wr = y_val.values[mask].mean()
        print(f"  P >= {thresh:.2f}: {mask.sum()} trades, {wr*100:.1f}% WR")

    print(f"\nTop features:")
    importance = model.get_booster().get_score(importance_type='gain')
    for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:10]:
        print(f"  {feat}: {imp:.1f}")

    return val_prob

# ============================================================
# 1. CRYPTO-ONLY MODEL (with proper per-symbol split)
# ============================================================
print("CRYPTO DATA:")
crypto_train, crypto_val = load_and_split(crypto_files, "Crypto")

X_train_c = crypto_train[features].fillna(0)
y_train_c = crypto_train['resolved_win']
X_val_c = crypto_val[features].fillna(0)
y_val_c = crypto_val['resolved_win']

crypto_model = train_model(X_train_c, y_train_c, X_val_c, y_val_c)
report(crypto_model, X_train_c, y_train_c, X_val_c, y_val_c, crypto_val, "CRYPTO-ONLY")

# ============================================================
# 2. STOCK-ONLY MODEL
# ============================================================
print("\n\nSTOCK DATA:")
stock_train, stock_val = load_and_split(stock_files, "Stock")

X_train_s = stock_train[features].fillna(0)
y_train_s = stock_train['resolved_win']
X_val_s = stock_val[features].fillna(0)
y_val_s = stock_val['resolved_win']

stock_model = train_model(X_train_s, y_train_s, X_val_s, y_val_s)
report(stock_model, X_train_s, y_train_s, X_val_s, y_val_s, stock_val, "STOCK-ONLY")

# ============================================================
# 3. COMBINED MODEL (with isCrypto + proper split)
# ============================================================
print("\n\nCOMBINED DATA (proper per-symbol split):")
combined_features = features + ['isCrypto']

all_train = pd.concat([crypto_train, stock_train], ignore_index=True)
all_val = pd.concat([crypto_val, stock_val], ignore_index=True)

# Shuffle training data (not validation - keep time order per symbol)
all_train = all_train.sample(frac=1, random_state=42).reset_index(drop=True)

X_train_all = all_train[combined_features].fillna(0)
y_train_all = all_train['resolved_win']
X_val_all = all_val[combined_features].fillna(0)
y_val_all = all_val['resolved_win']

combined_model = train_model(X_train_all, y_train_all, X_val_all, y_val_all)
report(combined_model, X_train_all, y_train_all, X_val_all, y_val_all, all_val, "COMBINED")

# ============================================================
# 4. ALSO TRY: fewer estimators for stocks (might be overfitting)
# ============================================================
print("\n\nSTOCK MODEL - FEWER TREES (50):")
stock_model_50 = train_model(X_train_s, y_train_s, X_val_s, y_val_s, n_estimators=50)
report(stock_model_50, X_train_s, y_train_s, X_val_s, y_val_s, stock_val, "STOCK-ONLY (50 trees)")

print("\n\nSTOCK MODEL - FEWER TREES (30):")
stock_model_30 = train_model(X_train_s, y_train_s, X_val_s, y_val_s, n_estimators=30)
report(stock_model_30, X_train_s, y_train_s, X_val_s, y_val_s, stock_val, "STOCK-ONLY (30 trees)")

# ============================================================
# FINAL RECOMMENDATION
# ============================================================
print(f"\n{'='*60}")
print(f"RECOMMENDATION")
print(f"{'='*60}")

crypto_val_acc = accuracy_score(y_val_c, crypto_model.predict(X_val_c))
stock_val_acc = accuracy_score(y_val_s, stock_model.predict(X_val_s))
combined_val_acc = accuracy_score(y_val_all, combined_model.predict(X_val_all))

# Check combined model per-market
combined_val_data = all_val.copy()
combined_val_data['pred'] = combined_model.predict(X_val_all)
crypto_in_combined = combined_val_data[combined_val_data['isCrypto'] == 1]
stock_in_combined = combined_val_data[combined_val_data['isCrypto'] == 0]

crypto_in_combined_acc = accuracy_score(crypto_in_combined['resolved_win'], crypto_in_combined['pred'])
stock_in_combined_acc = accuracy_score(stock_in_combined['resolved_win'], stock_in_combined['pred'])

print(f"Crypto-only model:        {crypto_val_acc*100:.1f}%")
print(f"Stock-only model:         {stock_val_acc*100:.1f}%")
print(f"Combined model (overall): {combined_val_acc*100:.1f}%")
print(f"Combined model (crypto):  {crypto_in_combined_acc*100:.1f}%")
print(f"Combined model (stock):   {stock_in_combined_acc*100:.1f}%")

if crypto_val_acc > crypto_in_combined_acc + 0.01:
    print("\n→ Combined model HURTS crypto — keep separate crypto model")
elif stock_val_acc < 0.54:
    print("\n→ Stock signal too weak for ML — disable ML for stocks, keep crypto-only model")
else:
    print("\n→ Deploy combined model")
