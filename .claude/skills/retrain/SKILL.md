---
name: retrain
description: Run the full ML retrain pipeline — copy CSVs from simulator, train models, copy JSONs back to iOS and worker
disable-model-invocation: true
allowed-tools: Bash(cp *) Bash(ls *) Bash(wc *) Bash(python3 *) Bash(find *) Bash(diff *) Read Glob Grep
---

# ML Retrain Pipeline

Run the full retrain cycle for MarketScope ML models.

## Steps

### 1. Locate simulator export CSVs

Find the latest ml_exports directory in the iOS simulator:

```
/Users/bojanmihovilovic/Library/Developer/CoreSimulator/Devices/F32D1D3F-AAA8-4BAC-8359-DA0CC59082CC/data/Containers/Data/Application/*/Documents/ml_exports/
```

There may be multiple app containers — use the one with the most recent CSVs.

### 2. Report what's available

Count CSVs and categorize:
- **Crypto**: filenames ending in `USDT.csv` (e.g., `BTCUSDT.csv`)
- **Stocks**: all other `.csv` files (e.g., `AAPL.csv`)

Report counts and ask user to confirm before proceeding.

### 3. Copy CSVs to training directory

Copy all CSVs to `ml-training/data/`:
```bash
mkdir -p ml-training/data
cp <simulator_path>/*.csv ml-training/data/
```

### 4. Run training script

```bash
cd ml-training && python3 calibrate_v9.py
```

This trains:
- **Crypto**: LightGBM depth=4, 150 trees
- **Stocks**: XGBoost depth=5, 100 trees

Watch for:
- Walk-forward accuracy (crypto target >73%, stocks >66%)
- Top-bucket reliability (>74% crypto, >76% stocks)
- Calibration stats
- Any feature count mismatches (should be 111)

Report the key metrics to the user.

### 5. Copy model JSONs to both targets

```bash
# iOS
cp ml-training/ml-model-crypto.json CryptoLens/ML/ml-model-crypto.json
cp ml-training/ml-model-stock.json CryptoLens/ML/ml-model-stock.json

# Worker
cp ml-training/ml-model-crypto.json marketscope-worker/src/ml-model-crypto.json
cp ml-training/ml-model-stock.json marketscope-worker/src/ml-model-stock.json
```

### 6. Verify parity

Confirm all 4 JSON files are identical to source:
```bash
diff ml-training/ml-model-crypto.json CryptoLens/ML/ml-model-crypto.json
diff ml-training/ml-model-stock.json CryptoLens/ML/ml-model-stock.json
diff ml-training/ml-model-crypto.json marketscope-worker/src/ml-model-crypto.json
diff ml-training/ml-model-stock.json marketscope-worker/src/ml-model-stock.json
```

Report tree count and feature count from each JSON to confirm they loaded correctly.

### 7. Summary

Report:
- Crypto WF accuracy + top-bucket reliability
- Stock WF accuracy + top-bucket reliability
- Number of training symbols (crypto + stocks)
- Total training bars
- Model files updated (4 locations)
- Remind user to rebuild iOS (`/deploy`) and redeploy worker (`wrangler deploy`)
