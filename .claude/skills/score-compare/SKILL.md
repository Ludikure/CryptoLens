---
name: score-compare
description: Compare iOS and worker ML scores for a symbol to find feature divergences
disable-model-invocation: true
argument-hint: <SYMBOL>
allowed-tools: Bash(curl *) Bash(jq *) Bash(python3 *) Read Glob Grep
---

# Score Compare: iOS vs Worker

Compare ML feature values and scores between iOS and the Cloudflare worker for symbol `$ARGUMENTS`.

If no symbol provided, default to BTCUSDT.

## Steps

### 1. Fetch worker scores

```bash
curl -s "https://marketscope-proxy.ludikure.workers.dev/ml-debug?symbol=$ARGUMENTS" | python3 -m json.tool
```

This returns the worker's feature dict, raw score, and calibrated probability.

### 2. Find iOS debug output

Check if there's a recent feature dump in the simulator logs or in Xcode console output. The iOS app has `MLScoring.dumpFeatureDict()` which prints features as JSON.

If no iOS dump is available, tell the user:
> Open the app on the simulator, navigate to the symbol, wait for refresh, then check the Xcode debug console for the feature JSON dump. Paste it here and I'll compare.

### 3. Compare features side-by-side

For each of the 111 features, compute:
- iOS value
- Worker value  
- Absolute difference
- Relative difference (%)

### 4. Report divergences

Show a table of features sorted by largest divergence, highlighting any with >10% relative difference:

```
Feature              iOS      Worker   Diff     Rel%
─────────────────────────────────────────────────
vpDistToPocATR       3.71     9.12     5.41     145%
oiChangePct          0.00     -2.34    2.34     100%
...
```

### 5. Diagnose

For each major divergence, explain the likely cause:
- VP divergence → candle count difference (should be last 30 daily)
- OI always 0 → missing previous OI tracking
- VIX at 20 → fetch failure, check KV cache
- Stock 4H/1H all zero → worker not fetching intraday for stocks
- Derivatives all 0 for stocks → expected (crypto-only features)

### 6. Suggest fixes

For each real divergence (not expected stock/crypto differences), suggest specific code changes with file paths and line numbers.
