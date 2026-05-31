# Additive model heads

Extra prediction heads layered on the quality model ([[ml-model-versions]]) without
touching it. Schema: `MODEL_JSON_SCHEMA.md`. The quality head stays top-level;
`heads.{meta,quantiles,conformal,direction}` are added in a separate
`ml-model-crypto.heads.json` (imported like the H72 head). The evaluator reads known heads,
ignores unknown ones — old clients degrade cleanly. Built by `ml-training/export_heads.py`.
Crypto only unless noted. Worker: `mlPredictMeta/Quantile/Direction/mlConfident` in
`ml-predict.ts`. The phases that *failed*: [[rejected-hypotheses]].

## Heads (all parity-proven worker↔Python < 1e-6)
- **meta** (Phase 1) — triple-barrier + meta-labeling. P(triple-barrier win | direction),
  conditioned on the union `metaDirection`. `CLF_BASE=0.5`.
- **quantiles** — predicted q75 of `fwdMaxFavR` (ATR) → adaptive TP2 runner. `QR_BASE=0.0`.
- **conformal** (Phase 2) — abstention gate via Wilson-90%-LB selective risk control.
  `mlConfident` true = trade-worthy. `CONF_TARGET=0.60`. On frozen holdout: lifted EV/trade
  +0.245R → **+0.754R** while trading ~⅓ as often. Default OFF in the app
  (`conformal_gate_enabled` UserDefault) — info-only until toggled.
- **direction** — own note: [[edge-crypto-direction-model]]. `DIR_CAP=0.95`.

## Parity gotcha (the bug that ate a day)
First meta-head parity FAILED at 3.88e-02. Causes, in order discovered:
1. `get_dump`/`trees_to_dataframe` round leaf values → parse `save_model` JSON instead.
2. XGBoost 3.x stores base_score bracketed (`[3.236E-1]`) and *learns* it → pinned
   `CLF_BASE=0.5`.
3. In `save_model`, **leaf output is `split_conditions[i]`**, not `base_weights` (they
   coincide for a classifier, diverge for a regressor) → switched to `scond[i]`.
Final: all heads PASS < 1e-6. Classifier serving: `baseLogit + Σleaves → sigmoid →
isotonic`. Regressor: `base + Σleaves`. Test: `marketscope-worker/test/heads-parity.test.ts`.

## Phase outcomes summary
- Phase 1 (meta) ✅ · Phase 2 (conformal) ✅ · direction head ✅ (separate effort)
- Phases 4 (context) / 5 (path) / 6 (ensemble) ❌ — no holdout lift, see
  [[rejected-hypotheses]]. The remaining edge was direction + execution, not more
  entry-quality heads.
