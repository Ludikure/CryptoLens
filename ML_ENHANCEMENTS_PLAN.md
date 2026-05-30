# ML / Setup-Quality Enhancements — Implementation Plan

Goal: improve the app's odds of identifying *correct* trade setups. Ordered by
leverage-for-effort and dependency. Excludes "prove it live" (separate track).

## Cross-cutting principles (apply to every phase)

1. **Parity is the tax.** Any feature or model change must update, in lockstep:
   iOS native evaluator (`ML/MLScoring.swift`, feature build in `IndicatorEngine`/
   `BacktestEngine`), worker (`scoring-full.ts`, `ml-predict.ts`), the model JSON,
   and the fixtures + 1e-7 tests (`test/parity-vs-backtest.test.ts`). Changes that
   touch the feature/model surface are *expensive* for this reason; serving-only and
   LLM-only changes are cheap. Budget accordingly.
2. **One scorecard.** Primary metric = **EV/trade (R) on the tradeable (triple-barrier)
   label**, plus top-bucket precision and coverage, measured on the clean forward split
   (`ml-training/edge_revalidate.py` methodology: timestamp split + time embargo, folds
   spanning the 2022 bear). Raw accuracy is secondary. Every experiment reports against
   the v11/v13 baseline on the *same* split.
3. **Honest gates.** Ship a change only if it beats baseline on the scorecard AND holds
   on the untouched holdout (Phase 0). Negative results get documented and dropped — same
   discipline that killed the derivative-direction primitives.
4. **Model-JSON schema designed once (Phase 1), extended thereafter.** The JSON grows from
   a single quality head to multiple heads (quality, meta, quantiles, ensemble members,
   conformal thresholds). Design the multi-head container up front so later phases slot in
   without re-touching the evaluator.

---

## Phase 0 — Foundation & guardrails  (effort S, risk low, PREREQUISITE)

Without this, experiments aren't comparable and overfitting is invisible.

- **Frozen holdout.** Carve the most recent ~6 months into a holdout that NO model
  selection ever sees. It's run once, at the end of each major phase, as the honest
  scorecard. (The clean forward split is for selection; the holdout is the final exam.)
- **Experiment harness.** Standardize a results JSON per experiment (extend the
  `comparison_results.json` pattern) capturing: split, EV/trade, per-bucket precision,
  coverage, per-regime breakdown. One function both markets call.
- **Multi-head model-JSON schema.** Define the container: `{quality, meta, quantiles[],
  ensemble[], conformal}` with versioning. Evaluator reads heads it knows, ignores the
  rest (forward-compatible, like `probabilityH72` was).
- **Gate:** harness reproduces current v11/v13 numbers on the clean split (sanity).

Files: `ml-training/_harness.py` (new), model JSON schema doc, `edge_revalidate.py` reused.

---

## Phase 1 — Label engineering  (effort L, risk med, HIGHEST LEVERAGE)

Changes the target everything trains on. Foundational; do first.

### 1a. Triple-barrier labeling
- In the CSV augmentation pipeline (`marketscope-worker/scripts/augment-csv.ts` + the
  Node backtest runner), add columns: `tbLabel` = first barrier hit (+1 TP / −1 SL /
  0 timeout) for the canonical SL/TP/horizon (start 1.0/1.5 ATR, 24h), plus 1–2 variants.
- New target `goodR_tb = (tbLabel == +1)` — *tradeable* goodR (a bar that dumps through
  your SL before running isn't "good" anymore).
- Retrain crypto+stock quality models on `goodR_tb`. Compare to v11/v13 on EV/trade.
- **Gate:** EV/trade improves (or top-bucket precision improves at equal coverage).

### 1b. Meta-labeling
- Primary model = the existing direction primitive (bias ∪ dStoch). Train a **meta-model**:
  features + proposed direction → P(win | we take it in that direction), target = the
  triple-barrier outcome *conditioned on the primitive's direction*.
- Serve as `ML_META` alongside `ML_WIN`. This is a direction-*conditioned* gate — strictly
  more precise than today's direction-agnostic one, and architecture-native (you already
  have the primary signal).
- **Gate:** gating on `ML_META` beats gating on `ML_WIN` (EV/trade, precision) on the split.

### 1c. Distributional / quantile target
- Train quantile regressors (GBM quantile loss) for `fwdMaxFavR` p50/p75/p90.
- Wire predicted p75/p90 into target selection (TP2) — replaces the fixed band from the
  recent runner-widening work, making TP2 per-bar adaptive.
- **Gate:** `composite_band_backtest.py` shows adaptive TP2 ≥ fixed 3.0 ATR crypto / 2.5 stock.

Files: `augment-csv.ts`, Node runner, new `calibrate_tb_*.py` / `calibrate_meta_*.py` /
`calibrate_quantile_*.py`, model JSON (3 new heads), `MLScoring.swift` + `scoring-full.ts`
+ `ml-predict.ts` (serve heads), parity fixtures + tests, `AnalysisPrompt.swift` (consume
`ML_META`, quantile TP2).

---

## Phase 2 — Conformal abstention  (effort S–M, risk low, CHEAPEST PRECISION WIN)

"Correct setup" is partly a precision problem — trade fewer, surer setups.

- Add an inductive/split-conformal step to training: nonconformity scores on a calibration
  fold → threshold for a target coverage. Emit thresholds into the model JSON (`conformal`).
- Serve `ML_CONFIDENT` (bool) / a confidence band per bar via `/ml-predict`. App abstains
  (NO SETUP) when not confident.
- **Gate:** precision/coverage curve confirms abstention lifts realized hit-rate on the
  taken subset (you already see 70–85% bucket hitting ~76–80% — formalize the abstention).

Files: conformal step in calibrate scripts, `ml-predict.ts` / `MLScoring.swift` (emit flag),
`AnalysisPrompt.swift` (abstain path), worker notify gate (optional: only notify if confident).

---

## Phase 3 — LLM layer  (effort S–M, risk low, PARALLELIZABLE — no retrain)

Independent of all ML work; can run alongside Phase 1. Unique to this app.

- **3a. Self-consistency gating.** Run the directional thesis N× (or Claude + Gemini) and
  emit a setup only when they agree on direction. Plumbing exists (provider abstraction,
  A/B TaskLocal). Cheap false-positive killer on the direction call.
- **3b. Adversarial critic pass.** Second LLM call whose only job is to *invalidate* the
  proposed setup (name the failure mode). Suppress/downgrade on a hard failure. Gate by
  conviction (only run on HIGH candidates) to bound cost/latency.
- **3c. Richer outcome feedback.** Feed per-archetype × per-regime realized hit-rates into
  the prompt (`OutcomeTracker` stores outcomes; extend the aggregation).
- **Cost note:** more LLM calls = latency + \$. Gate by conviction tier.

Files: `AnalysisService` (multi-call orchestration), `AnalysisPrompt.swift` (critic prompt),
`OutcomeTracker` (archetype×regime aggregation), worker `/analyze` if mirrored.

---

## Phase 4 — Context features  (effort M–L, risk med, parity-heavy)

- **4a. Weekly timeframe anchor.** Compute weekly trend/structure features (with/against the
  dominant tide). Parity work on both sides.
- **4b. Breadth / macro-regime.** % of universe above its 200D, BTC dominance shift,
  advance/decline. Natural fit for the worker cron's universe pass → a global breadth blob
  persisted in KV → fed as features. Generalizes the new BTC-200D regime flag.
- **4c. Levels as features.** Turn tagged-levels logic into numerics: dist-to-nearest-
  untested-level, confluence density, "room to run" before next obstacle — directly predicts
  whether a 1.5–3 ATR target is reachable. You compute levels already; feed the model.
- **Gate:** each added as an ablation — keep only those that add EV/trade.

Files: feature build (iOS `IndicatorEngine`/`BacktestEngine` + worker `scoring-full.ts` —
parity), worker cron (breadth blob), fixtures + tests, training.

---

## Phase 5 — Direction enhancements  (effort M–H, risk HIGH/uncertain)

Attacks the ~50/50 weak spot. Honest expectation: modest gains; gate hard.

- **5a. Path/sequence features.** Add run-length, bars-since-swing, slope-of-slope,
  range-compression, efficiency ratio. Direction is where path shape matters most.
- **5b. Regime-conditional direction.** Train the meta-model (1b) with regime interactions
  (or separate meta-models per regime) — your per-fold data shows dStoch EV swings by regime.
- **5c. (Experimental, Python-only first) small sequence model** (1D-conv/temporal) for
  direction. Productionize ONLY if it clearly beats the GBM on the split — else document and
  drop. Don't ship serving complexity that doesn't pay.

Files: feature build (parity), meta-model training, fixtures. 5c stays in `ml-training/`
until it clears the bar.

---

## Phase 6 — Model architecture  (effort M–H, risk med, polish)

- **6a. Ensemble/stacking.** Blend the GBM with a diverse learner (regularized logistic on a
  curated subset, or a local/k-NN model) via a meta-learner — better calibration + tails.
- **6b. Per-cluster models / symbol embeddings.** Cluster symbols by vol/beta/liquidity (the
  77-crypto / 159-stock pools are heterogeneous — BTC ≠ microcap alt). Train per-cluster or
  add cluster features.
- **6c. Combinatorial Purged CV (CPCV)** for model selection — robust selection + an OOS
  performance *distribution* instead of one path. Reduces overfit-model selection risk.
- **Serving:** evaluator extends to multiple ensemble members + blend (JSON schema from
  Phase 0); parity tests cover the blend.

Files: training scripts, evaluator (`MLScoring.swift` + `ml-predict.ts`), fixtures.

---

## Phase 7 — Closeout: archetype gating + holdout scorecard  (effort S, continuous)

- **7a. Archetype × regime gating.** Track realized hit-rate per archetype × regime
  (`OutcomeTracker`) → gate/size by it; let data prune weak setup types.
- **7b. Final holdout run.** Run the full enhanced stack once on the frozen Phase-0 holdout
  for the honest end-to-end scorecard vs the v11/v13 baseline.

---

## Sequencing & dependency map

```
Phase 0 (foundation) ──┬─> Phase 1 (label) ──> Phase 2 (conformal) ──> Phase 5 (direction)
                       │                                          └──> Phase 6 (architecture)
                       ├─> Phase 4 (context features) ────────────────┘
                       └─> Phase 3 (LLM) ── runs in parallel, no ML dependency
Phase 7 (closeout) ── after each major phase + at the very end
```

Recommended order of execution by ROI: **0 → 1 → 2 → 3 (parallel) → 4 → 5 → 6 → 7.**
The first three (label, conformal, LLM) are the highest ROI: they make the label honest,
make the system selective, and add free precision. 4–6 are heavier with less certain payoff;
gate each hard and be willing to drop negatives.

## Effort / risk summary

| Phase | What | Effort | Risk | Parity cost | Parallel? |
|------:|------|:------:|:----:|:-----------:|:---------:|
| 0 | foundation/harness/holdout | S | low | none | — |
| 1 | triple-barrier + meta-label + quantile | L | med | high | no (foundational) |
| 2 | conformal abstention | S–M | low | low | after a model |
| 3 | LLM self-consistency + critic + feedback | S–M | low | none | yes |
| 4 | weekly + breadth + levels features | M–L | med | high | with 1 |
| 5 | path/sequence + regime-conditional dir | M–H | high | high | after 1 |
| 6 | ensemble + per-cluster + CPCV | M–H | med | high | after 1 |
| 7 | archetype gating + holdout exam | S | low | none | continuous |
