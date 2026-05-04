# Worker parity tests

Catches drift between worker-side and iOS-side feature computation. The two implementations must produce identical outputs on identical inputs — otherwise notifications (worker ML) and in-app analyses (iOS ML) disagree.

## Running

```sh
cd marketscope-worker
npm install        # one-time
npm test           # runs all tests
npm run test:watch # re-runs on file changes
```

`npm run deploy` runs tests automatically (via `predeploy` hook). Failed tests block deploy.

## What's covered

### `aggregation.test.ts`
Pins `aggregate1HTo4H_ET` behavior — the 1H→4H aggregation for stocks. This was the source of the May 4, 2026 ML-divergence bug (worker used UTC buckets, iOS used ET trading days). Regression test included.

### `feature-parity.test.ts`
Smoke tests for `computeAllFeatures`:
- Returns all expected feature names
- All values finite (no NaN/Infinity)
- Macro passthrough works
- Crypto vs stock branching produces correct defaults

## Adding numeric parity tests against iOS

Synthetic input is fine for catching renames and crashes, but doesn't catch *math* drift. To assert worker math matches iOS math:

1. **Capture from iOS:** the app's `AnalysisService.swift` already dumps feature dicts for BTC/ETH (`#if DEBUG` block around line 542). Extend to your target symbol.
2. **Run analysis** on the simulator. Retrieve the JSON from
   `~/Library/Developer/CoreSimulator/Devices/<id>/data/Containers/Data/Application/<id>/Documents/<symbol>_features.json`.
3. **Capture inputs**: log the raw candles, derivatives, dark pool, etc. that iOS used. (Worth adding a similar dump for these — currently absent.)
4. **Build a fixture** in `test/fixtures/<symbol>_<date>.json` containing both inputs and expected outputs.
5. **Add a test** that runs `computeAllFeatures(...inputs)` and asserts every key matches expected within `0.0001` tolerance.

Once one fixture exists, others can be added in the same shape.

## When tests fail

- **Aggregation test fails after a change to `aggregation.ts`**: did iOS's `CandleAggregator.swift` change too? Mirror the change.
- **Feature test fails after a change to `scoring-full.ts`**: was the change intentional? Update the expected values *and* mirror in iOS `buildMLFeatures`.
- **Test passes locally but ML still diverges in production**: the gap is in a feature not yet covered by tests. Add a fixture for the divergent symbol.
