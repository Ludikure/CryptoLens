---
name: sync-models
description: Verify and sync ML model JSONs between iOS app, worker, and training directory
disable-model-invocation: true
allowed-tools: Bash(cp *) Bash(diff *) Bash(md5 *) Bash(wc *) Bash(python3 *) Read Glob Grep
---

# Sync ML Models

Ensure `ml-model-crypto.json` and `ml-model-stock.json` are identical across all 3 locations:
1. `ml-training/` (source of truth after training)
2. `CryptoLens/ML/` (iOS app)
3. `marketscope-worker/src/` (Cloudflare worker)

## Steps

### 1. Check all copies exist

```bash
ls -la ml-training/ml-model-crypto.json ml-training/ml-model-stock.json
ls -la CryptoLens/ML/ml-model-crypto.json CryptoLens/ML/ml-model-stock.json  
ls -la marketscope-worker/src/ml-model-crypto.json marketscope-worker/src/ml-model-stock.json
```

### 2. Compare checksums

```bash
md5 ml-training/ml-model-crypto.json CryptoLens/ML/ml-model-crypto.json marketscope-worker/src/ml-model-crypto.json
md5 ml-training/ml-model-stock.json CryptoLens/ML/ml-model-stock.json marketscope-worker/src/ml-model-stock.json
```

### 3. Report status

For each model (crypto, stock):
- Are all 3 copies identical? 
- If not, which ones differ and what are the timestamps?
- Extract and report from each JSON:
  - Number of trees
  - Number of features  
  - Calibration table size
  - Model type (xgboost/lightgbm)

### 4. Fix divergences

If copies differ:
- Use `ml-training/` as source of truth (most recently trained)
- Copy to iOS and worker locations
- Verify with diff

If `ml-training/` is older than iOS/worker copies, warn the user — someone may have manually edited a deployed copy.

### 5. Summary

```
Model Sync Status
─────────────────
Crypto: [SYNCED/OUT OF SYNC]
  Trees: XXX | Features: 111 | Type: lightgbm
  Calibration: XX buckets, max 0.85
  
Stock:  [SYNCED/OUT OF SYNC]
  Trees: XXX | Features: 111 | Type: xgboost
  Calibration: XX buckets, max 0.85

All locations: ml-training/ | CryptoLens/ML/ | marketscope-worker/src/
```
