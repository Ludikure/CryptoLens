# Multi-head model JSON schema (Phase 0)

Design for the model JSON that `MLScoring.swift` (iOS native evaluator) and
`marketscope-worker/src/ml-predict.ts` read. Goal: grow from one head to many
WITHOUT breaking existing serving or the 1e-7 parity contract.

## Backward-compatibility rule

The **existing top-level keys stay exactly where they are** and remain the
**quality head**. Old evaluator code keeps reading `trees` / `base_score` /
`calibration` / `features` unchanged. New heads are added under an **additive
`heads` object** — the evaluator reads heads it recognizes and ignores the rest
(identical to how `probabilityH72` was added additively without breaking old
clients). No phase rewrites the evaluator's core tree walk; each phase adds a
head + a small read path.

## Container

```jsonc
{
  // ── QUALITY HEAD (existing, unchanged — backward compatible) ──────────────
  "features": ["dRsi", ...],        // 111 (or more after Phase 4); shared by all heads
  "trees": [ ... ],                 // GBM trees, quality head
  "base_score": 0.5,
  "calibration": { ... },           // isotonic, quality head
  "target": "goodR_tb",             // Phase 1a: tradeable triple-barrier label
  "version": 14, "market": "crypto", "engine": "lightgbm",
  "n_features": 111, "n_trees": 150, "n_samples": 136551,
  "model_type": "classifier", "description": "...",

  // ── ADDITIVE HEADS (new; evaluator reads known, ignores unknown) ──────────
  "heads": {

    // Phase 1b — meta-label: P(win | we take the primitive's direction)
    "meta": {
      "kind": "classifier",
      "conditioned_on": "direction",   // direction is appended to the feature vector
      "trees": [ ... ], "base_score": 0.5,
      "calibration": { ... },
      "target": "tb_win_given_dir"
    },

    // Phase 1c — distributional fwdMaxFavR (drives adaptive TP2)
    "quantiles": {
      "kind": "regressor",
      "target": "fwdMaxFavR",
      "q": {
        "0.50": { "trees": [ ... ], "base_score": 0.0 },
        "0.75": { "trees": [ ... ], "base_score": 0.0 },
        "0.90": { "trees": [ ... ], "base_score": 0.0 }
      }
    },

    // Phase 2 — conformal abstention thresholds (no trees; thresholds only)
    "conformal": {
      "target_coverage": 0.80,
      "threshold": 0.0,                // global nonconformity cutoff
      "per_regime": { "TRENDING": 0.0, "RANGING": 0.0, "TRANSITIONING": 0.0 }
    },

    // Phase 6 — ensemble: members + blend (only present if ensembling ships)
    "ensemble": {
      "members": [
        { "id": "gbm",      "kind": "classifier", "trees": [ ... ], "base_score": 0.5 },
        { "id": "logistic", "kind": "linear",     "weights": [ ... ], "bias": 0.0,
          "feature_subset": ["dRsi", ...] }
      ],
      "blend": { "type": "logistic", "weights": [0.6, 0.4], "bias": 0.0 },
      "calibration": { ... }
    }
  }
}
```

## Serving contract (`/ml-predict` response, additive)

Worker computes every present head once per symbol per cron and returns:

```jsonc
{
  "symbol": "BTCUSDT",
  "probability": 0.72,        // quality head (existing field; unchanged)
  "probabilityH72": 0.61,     // existing persistence field
  "probabilityMeta": 0.68,    // Phase 1b — null if no meta head
  "q50": 1.4, "q75": 2.6, "q90": 3.9,   // Phase 1c — null if no quantile head (ATR units)
  "confident": true,          // Phase 2 — null if no conformal head
  "features": { ... }
}
```

iOS reads the fields it knows; missing keys → nil → today's behavior. No field is
ever removed or repurposed (the cooldown/rotation lesson: additive only).

## Parity obligations per head

| Head | New evaluator path | Parity fixture asserts |
|------|--------------------|------------------------|
| quality | (exists) | probability @1e-7 |
| meta | tree walk + append `direction` feature | probabilityMeta @1e-7 |
| quantiles | tree walk × 3, no calibration | q50/q75/q90 @1e-7 |
| conformal | threshold compare (no trees) | confident bool exact |
| ensemble | members + blend | blended prob @1e-7 |

Each head added to a fixture (BTC/ETH/TSLA) and asserted in
`test/parity-vs-backtest.test.ts`. `predeploy` blocks deploy on any parity break.

## Versioning

Bump top-level `version` on any quality-head retrain. Add `heads.<name>.version`
per head so heads can be retrained independently. The training scripts
(`calibrate_*`) write both iOS + worker copies in one step (existing workflow).
