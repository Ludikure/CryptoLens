import pandas as pd
import xgboost as xgb
import numpy as np
from sklearn.metrics import accuracy_score
import json

# All 16 symbols
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
    'GOOG': '/Users/bojanmihovilovic/Downloads/GOOG',
    'META': '/Users/bojanmihovilovic/Downloads/META',
    'JPM': '/Users/bojanmihovilovic/Downloads/JPM',
    'UNH': '/Users/bojanmihovilovic/Downloads/UNH',
    'XOM': '/Users/bojanmihovilovic/Downloads/XOM',
    'HD': '/Users/bojanmihovilovic/Downloads/HD',
    'MA': '/Users/bojanmihovilovic/Downloads/MA',
}

# 51 ML features (matches expanded MLFeatures struct)
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
]

# Also test with old 23 features for comparison
old_features = [
    'dRsi', 'dMacdHist', 'dAdx', 'dAdxBullish',
    'dEmaCross', 'dStackBull', 'dStackBear', 'dStructBull', 'dStructBear',
    'hRsi', 'hMacdHist', 'hAdx', 'hAdxBullish',
    'hEmaCross', 'hStackBull', 'hStackBear', 'hStructBull', 'hStructBear',
    'atrPercent', 'volScalar', 'atrPercentile',
    'dailyScore', 'fourHScore',
]

def load_and_split(files, label):
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
        max_depth=3, n_estimators=n_estimators, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)
    return model

def report(model, X_train, y_train, X_val, y_val, val_data, label, feat_list):
    val_pred = model.predict(X_val)
    val_prob = model.predict_proba(X_val)[:, 1]
    val_acc = accuracy_score(y_val, val_pred)
    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"{'='*60}")
    print(f"Train: {accuracy_score(y_train, model.predict(X_train))*100:.1f}%")
    print(f"Val:   {val_acc*100:.1f}% (baseline {y_val.mean()*100:.1f}%, lift +{(val_acc-y_val.mean())*100:.1f}pp)")

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

    print(f"\nTop 15 features:")
    importance = model.get_booster().get_score(importance_type='gain')
    for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:15]:
        print(f"  {feat}: {imp:.1f}")

    # Return new features in top 15
    new_feats = set(feat_list) - set(old_features)
    new_in_top = [(f, importance.get(f, 0)) for f in new_feats if f in importance]
    new_in_top.sort(key=lambda x: x[1], reverse=True)
    if new_in_top:
        print(f"\nNew features ranked by importance:")
        for f, imp in new_in_top[:10]:
            rank = sorted(importance.values(), reverse=True).index(imp) + 1
            print(f"  {f}: {imp:.1f} (rank {rank}/{len(importance)})")

    return val_acc, val_prob

# ============================================================
# CRYPTO
# ============================================================
print("CRYPTO DATA:")
crypto_train, crypto_val = load_and_split(crypto_files, "Crypto")

# Old features baseline
print("\n--- CRYPTO: OLD 23 FEATURES (baseline) ---")
X_tc_old = crypto_train[old_features].fillna(0); y_tc = crypto_train['resolved_win']
X_vc_old = crypto_val[old_features].fillna(0); y_vc = crypto_val['resolved_win']
crypto_old = train_model(X_tc_old, y_tc, X_vc_old, y_vc)
old_crypto_acc, _ = report(crypto_old, X_tc_old, y_tc, X_vc_old, y_vc, crypto_val, "CRYPTO OLD (23 feat)", old_features)

# New features
print("\n--- CRYPTO: NEW 51 FEATURES ---")
X_tc = crypto_train[features].fillna(0)
X_vc = crypto_val[features].fillna(0)
crypto_new = train_model(X_tc, y_tc, X_vc, y_vc)
new_crypto_acc, _ = report(crypto_new, X_tc, y_tc, X_vc, y_vc, crypto_val, "CRYPTO NEW (51 feat)", features)

# ============================================================
# STOCK
# ============================================================
print("\n\nSTOCK DATA:")
stock_train, stock_val = load_and_split(stock_files, "Stock")

# Old features baseline
print("\n--- STOCK: OLD 23 FEATURES (baseline) ---")
X_ts_old = stock_train[old_features].fillna(0); y_ts = stock_train['resolved_win']
X_vs_old = stock_val[old_features].fillna(0); y_vs = stock_val['resolved_win']
stock_old = train_model(X_ts_old, y_ts, X_vs_old, y_vs, n_estimators=50)
old_stock_acc, _ = report(stock_old, X_ts_old, y_ts, X_vs_old, y_vs, stock_val, "STOCK OLD (23 feat, 50 trees)", old_features)

# New features
print("\n--- STOCK: NEW 51 FEATURES ---")
X_ts = stock_train[features].fillna(0)
X_vs = stock_val[features].fillna(0)
stock_new_150 = train_model(X_ts, y_ts, X_vs, y_vs, n_estimators=150)
new_stock_acc_150, _ = report(stock_new_150, X_ts, y_ts, X_vs, y_vs, stock_val, "STOCK NEW (51 feat, 150 trees)", features)

stock_new_50 = train_model(X_ts, y_ts, X_vs, y_vs, n_estimators=50)
new_stock_acc_50, _ = report(stock_new_50, X_ts, y_ts, X_vs, y_vs, stock_val, "STOCK NEW (51 feat, 50 trees)", features)

stock_new_75 = train_model(X_ts, y_ts, X_vs, y_vs, n_estimators=75)
new_stock_acc_75, _ = report(stock_new_75, X_ts, y_ts, X_vs, y_vs, stock_val, "STOCK NEW (51 feat, 75 trees)", features)

# ============================================================
# SUMMARY
# ============================================================
print(f"\n{'='*60}")
print(f"SUMMARY: OLD vs NEW FEATURES")
print(f"{'='*60}")
print(f"Crypto old (23 feat): {old_crypto_acc*100:.1f}%")
print(f"Crypto new (51 feat): {new_crypto_acc*100:.1f}%  {'✓ BETTER' if new_crypto_acc > old_crypto_acc + 0.01 else '✗ NOT BETTER'}")
print(f"Stock old (23 feat):  {old_stock_acc*100:.1f}%")
print(f"Stock new 150 trees:  {new_stock_acc_150*100:.1f}%  {'✓ BETTER' if new_stock_acc_150 > old_stock_acc + 0.01 else '✗ NOT BETTER'}")
print(f"Stock new 50 trees:   {new_stock_acc_50*100:.1f}%  {'✓ BETTER' if new_stock_acc_50 > old_stock_acc + 0.01 else '✗ NOT BETTER'}")
print(f"Stock new 75 trees:   {new_stock_acc_75*100:.1f}%  {'✓ BETTER' if new_stock_acc_75 > old_stock_acc + 0.01 else '✗ NOT BETTER'}")

delta_c = (new_crypto_acc - old_crypto_acc) * 100
delta_s = max(new_stock_acc_150, new_stock_acc_50, new_stock_acc_75) - old_stock_acc
delta_s *= 100
print(f"\nCrypto improvement: {'+' if delta_c >= 0 else ''}{delta_c:.1f}pp")
print(f"Stock improvement:  {'+' if delta_s >= 0 else ''}{delta_s:.1f}pp")

if delta_c > 1 or delta_s > 1:
    print("\n→ NEW FEATURES HELP — export and deploy updated models")
else:
    print("\n→ NEW FEATURES MARGINAL — check if specific feature groups help via ablation")
