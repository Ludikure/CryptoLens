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
    'AAPL': '/Users/bojanmihovilovic/Downloads/AAPL (1)',
    'MSFT': '/Users/bojanmihovilovic/Downloads/MSFT (1)',
    'NVDA': '/Users/bojanmihovilovic/Downloads/NVDA (1)',
    'TSLA': '/Users/bojanmihovilovic/Downloads/TSLA (1)',
    'AMZN': '/Users/bojanmihovilovic/Downloads/AMZN (1)',
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
        max_depth=3, n_estimators=n_estimators, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', random_state=42
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)
    return model

def report(model, X_train, y_train, X_val, y_val, val_data, label, feat_list):
    val_pred = model.predict(X_val)
    val_prob = model.predict_proba(X_val)[:, 1]
    print(f"\n{'='*60}")
    print(f"{label}")
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

    # Per-market thresholds if combined
    if 'isCrypto' in val_data.columns:
        for mkt, lbl in [(1, 'Crypto'), (0, 'Stock')]:
            mkt_mask = val_data['isCrypto'] == mkt
            if mkt_mask.sum() == 0: continue
            print(f"\n  {lbl} probability thresholds:")
            for thresh in [0.50, 0.55, 0.60, 0.65, 0.70]:
                mask = (val_data['prob'] >= thresh) & mkt_mask
                if mask.sum() == 0: continue
                wr = val_data.loc[mask, 'resolved_win'].mean()
                print(f"    P >= {thresh:.2f}: {mask.sum()} trades, {wr*100:.1f}% WR")

    print(f"\nTop features:")
    importance = model.get_booster().get_score(importance_type='gain')
    for feat, imp in sorted(importance.items(), key=lambda x: x[1], reverse=True)[:12]:
        print(f"  {feat}: {imp:.1f}")
    return val_prob

# ============================================================
# CRYPTO-ONLY (baseline comparison)
# ============================================================
print("CRYPTO DATA:")
crypto_train, crypto_val = load_and_split(crypto_files, "Crypto")
X_tc = crypto_train[features].fillna(0); y_tc = crypto_train['resolved_win']
X_vc = crypto_val[features].fillna(0); y_vc = crypto_val['resolved_win']
crypto_model = train_model(X_tc, y_tc, X_vc, y_vc)
report(crypto_model, X_tc, y_tc, X_vc, y_vc, crypto_val, "CRYPTO-ONLY MODEL", features)

# ============================================================
# STOCK-ONLY (with more data now)
# ============================================================
print("\n\nSTOCK DATA:")
stock_train, stock_val = load_and_split(stock_files, "Stock")
X_ts = stock_train[features].fillna(0); y_ts = stock_train['resolved_win']
X_vs = stock_val[features].fillna(0); y_vs = stock_val['resolved_win']
stock_model = train_model(X_ts, y_ts, X_vs, y_vs)
report(stock_model, X_ts, y_ts, X_vs, y_vs, stock_val, "STOCK-ONLY MODEL (10yr data)", features)

# Also try fewer trees
stock_model_50 = train_model(X_ts, y_ts, X_vs, y_vs, n_estimators=50)
report(stock_model_50, X_ts, y_ts, X_vs, y_vs, stock_val, "STOCK-ONLY (50 trees)", features)

# ============================================================
# COMBINED with isCrypto
# ============================================================
print("\n\nCOMBINED DATA:")
combined_features = features + ['isCrypto']
all_train = pd.concat([crypto_train, stock_train], ignore_index=True)
all_val = pd.concat([crypto_val, stock_val], ignore_index=True)
all_train = all_train.sample(frac=1, random_state=42).reset_index(drop=True)

X_ta = all_train[combined_features].fillna(0); y_ta = all_train['resolved_win']
X_va = all_val[combined_features].fillna(0); y_va = all_val['resolved_win']
combined_model = train_model(X_ta, y_ta, X_va, y_va)
report(combined_model, X_ta, y_ta, X_va, y_va, all_val, "COMBINED MODEL (isCrypto)", combined_features)

# ============================================================
# SUMMARY
# ============================================================
print(f"\n{'='*60}")
print(f"SUMMARY COMPARISON")
print(f"{'='*60}")

c_acc = accuracy_score(y_vc, crypto_model.predict(X_vc))
s_acc = accuracy_score(y_vs, stock_model.predict(X_vs))
a_acc = accuracy_score(y_va, combined_model.predict(X_va))

# Combined per-market
comb_val = all_val.copy()
comb_val['pred'] = combined_model.predict(X_va)
c_in_comb = comb_val[comb_val['isCrypto'] == 1]
s_in_comb = comb_val[comb_val['isCrypto'] == 0]
cc_acc = accuracy_score(c_in_comb['resolved_win'], c_in_comb['pred'])
sc_acc = accuracy_score(s_in_comb['resolved_win'], s_in_comb['pred'])

print(f"Crypto-only model:          {c_acc*100:.1f}% (baseline {y_vc.mean()*100:.1f}%)")
print(f"Stock-only model:           {s_acc*100:.1f}% (baseline {y_vs.mean()*100:.1f}%)")
print(f"Combined overall:           {a_acc*100:.1f}% (baseline {y_va.mean()*100:.1f}%)")
print(f"Combined → crypto subset:   {cc_acc*100:.1f}%")
print(f"Combined → stock subset:    {sc_acc*100:.1f}%")

# Decision
stock_lift = s_acc - y_vs.mean()
print(f"\nStock lift: +{stock_lift*100:.1f}pp")
if s_acc > 0.55:
    print("→ Stock model has signal! Consider deploying.")
elif s_acc > 0.53:
    print("→ Marginal stock signal. Probability filtering may help.")
else:
    print("→ Stock signal still weak. Features may not suit equities.")
