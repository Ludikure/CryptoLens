---
name: model-eval
description: Run model comparison across configurations and report accuracy metrics
disable-model-invocation: true
allowed-tools: Bash(python3 *) Bash(ls *) Bash(wc *) Read Glob
---

# Model Evaluation

Run `model_comparison.py` to evaluate different model configurations on the latest backtest data.

## Steps

### 1. Verify data exists

Check that CSVs exist in `ml-training/data/`:
```bash
ls ml-training/data/*.csv | wc -l
```

If no data, tell user to run `/backtest-status` first and copy CSVs.

### 2. Run comparison

```bash
cd /Users/bojanmihovilovic/CryptoLens/ml-training && python3 model_comparison.py
```

This tests 10 configurations:
- XGBoost: depth 3/4/5 x trees 100/150/200
- LightGBM: depth 3/4/5

For both crypto and stock subsets.

### 3. Parse and format results

Present a clean comparison table:

```
CRYPTO MODELS
Config          WF Acc   Top Bucket   Samples    AUC
────────────────────────────────────────────────────
XGB d3 t100     72.9%    74.1%        8,264      0.79
XGB d4 t150     73.1%    76.2%        8,264      0.80
LGB d4 t150     73.4%    78.7%        8,264      0.81
...

STOCK MODELS
Config          WF Acc   Top Bucket   Samples    AUC
────────────────────────────────────────────────────
XGB d5 t100     66.1%    76.2%        18,550     0.72
...
```

### 4. Recommendation

Highlight the best config for each market:
- **Crypto**: prioritize top-bucket reliability (that's where trades happen)
- **Stocks**: prioritize top-bucket reliability + sample count

Compare against current production models:
- Current crypto: LGB d4 t150 — 73.4% WF, 78.7% top bucket
- Current stocks: XGB d5 t100 — 66.1% WF, 76.2% top bucket

Flag if any config beats current production by >1pp on top bucket.

### 5. Ask user

If a better config is found, ask if they want to retrain with it. If yes, suggest running `/retrain`.
