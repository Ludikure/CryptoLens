# ML Enhancements Plan — Outcomes (all 8 phases)

Executive summary of the plan in `ML_ENHANCEMENTS_PLAN.md`. Every result is on the
clean forward split with a **frozen 6-month holdout** (≥ 2025-11-26) never seen
during selection/calibration. Production serving rollout is gated on a manual
parity-fixture capture step (see §Ship).

## What was validated (crypto) vs dropped

| Phase | Change | Verdict |
|------:|--------|---------|
| 0 | Harness, frozen holdout, multi-head model schema | ✅ foundation |
| 1 | Triple-barrier tradeable label + meta-model + quantile TP2 | ✅ **SHIP (crypto)** — holdout-confirmed |
| 2 | Conformal abstention (selective risk control) | ✅ **SHIP (crypto)** — tunable, guaranteed |
| 3 | Agreement "priority tier" (offline) + LLM self-consistency/critic | ◑ tier offline-proven; LLM needs live A/B |
| 4 | Context features (breadth + weekly) | ✗ DROP (−0.008R) |
| 5 | Path/sequence features; regime-conditional direction | ✗ DROP (+0.000R); regime already captured |
| 6 | Ensemble; per-cluster | ✗ ensemble DROP (−0.010R); per-cluster marginal (+0.022R) |
| 7 | End-to-end closeout | ✅ 5.7× total R; tunable precision/volume dial |

## The headline findings

1. **The current label is materially optimistic.** 17% (crypto) / 49% (stock) of
   `goodR=1` "good" bars are actually triple-barrier *losses* (stopped before the
   target). The triple-barrier meta-label fixes this — Phase 1's biggest contribution.

2. **Conformal abstention is the best risk-adjusted win.** vs trade-everything it is
   *dominant* on the holdout (EV/trade +0.245R → +0.754R, win 53.9% → 73.4%, higher
   total R at 1/3 the exposure), with a finite-sample win-rate guarantee that held
   out-of-sample.

3. **Production's rising-edge gate is overly restrictive.** Closeout (Phase 7): the
   enhanced stack takes ~10,800 holdout trades production *skips*, averaging
   **+0.89R each** → 5.7× total R (+11,702 vs +2,045) at a still-strong +0.95R/trade.
   The conformal τ is a dial: lower = volume (more +EV opportunities), higher =
   precision (match/exceed production's +1.37R/trade at higher volume than rising-edge).

4. **The stack is saturated on this feature set.** Phases 4–6 (context, path,
   ensemble) returned marginal-to-negative — the Phase 1+2 combo already extracts the
   available edge. Don't chase more features; the remaining real upside is the LLM
   layer (live A/B only).

5. **Stocks: abstain at this horizon.** The meta head + conformal correctly refuse to
   trade — stock setups aren't tradeable-win-positive here (holdout baseline +0.05R,
   breakeven). Honest negative; revisit with a different horizon or relative ranking.

## Net validated crypto stack (ready to build)
Triple-barrier meta label → calibrated meta-prob → conformal abstention gate
(τ≈0.374 for volume, higher for precision) → union direction → composite execution
with **adaptive TP2 = clip(predicted q75, 2–5 ATR)** → optional agreement
priority-conviction tier (bias & dStoch agree → +0.13R/trade).

## Ship (remaining work — gated on a manual step)
1. Retrain production crypto quality + **meta** + **quantile** heads; write
   `heads.{meta,quantiles,conformal}` into the model JSON per `MODEL_JSON_SCHEMA.md`
   (additive; quality head unchanged).
2. Implement the read paths in `ML/MLScoring.swift` + `marketscope-worker/src/
   ml-predict.ts` at 1e-7 parity.
3. **Capture new parity fixtures** — needs the manual iOS BacktestView → "Capture
   Parity Fixture" (DEBUG) step. **(Blocker — requires the user.)**
4. Serve `probabilityMeta` / `q75` / `confident`; gate prompt + notify on the
   conformal `confident` flag; feed q75 into target selection; surface the agreement
   priority tier as a high-conviction badge.
5. Deploy worker + install iOS; re-run the holdout exam post-ship.

## Live-A/B-only (not shippable blind)
LLM self-consistency (N-sample / Claude+Gemini agreement) + adversarial critic +
per-archetype×regime outcome feedback (Phase 3 / 7a). Implement behind the existing
A/B bucket; validate via OutcomeDashboard resolved-R before default-on.

Scripts: `phase{1..7}*.py`, `_harness.py`. All results in `phase_results.json`.
Per-phase detail in `PHASE{1..6}_RESULTS.md`.
