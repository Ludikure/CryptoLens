# T5 — Volatility-conditioned tail strategy — PRE-DECLARED DESIGN

**Status:** frozen 2026-08-23, BEFORE any result. Design specified by the user; recorded here
verbatim in substance so the bar cannot drift.

## Why this is a cleaner hypothesis than anything else outstanding

Both components already have **independent empirical support**, which no other candidate in the
vault can claim:

- The convex 1R/5R structure is the one genuine gross edge measured here — **+0.151R**
  ([[strategy-breakeven]]), dying only at retail fees.
- The volatility model holds **WF AUC ~0.674** with calibration that survives live forward grading
  ([[ml-model-versions]]).

The hypothesis is therefore NOT "volatility predicts direction". It is:

> **The convex payoff is more valuable when the market is predicted to move unusually far.**

No new features, no directional claim, no retraining. It asks whether one proven signal can time the
deployment of another proven structure.

- **H0:** filtering convex trades by predicted volatility does not improve net EV per unit capital.
- **H1:** it does, by enough to matter after costs.

## Method

- **Universe/period:** the crypto symbols with full 1h OHLC history; same period as the convex test.
- **Base strategy, unchanged:** 1R stop, 5R target, 72h horizon, direction-agnostic, tail-gated
  entry (top-decile `P(fwdMaxFavR72H >= 5)`, matching `strategy_tail_test.py`).
- **Model:** production config frozen — LightGBM d4/t150. No retraining, no hyperparameter search.
- **Costs:** 0.25% round trip (the user's actual fee).
- **Simulator:** **OHLC path simulation on 1h bars**, so the absolute result is comparable with the
  trustworthy +0.151R gross / −0.008R net. Close-only simulation is explicitly disallowed as evidence
  of tradeability. Same-bar stop/target ambiguity is charged as the STOP, identically in every arm.
- **Walk-forward:** existing 3-fold expanding framework, 48-bar purge.

### Arms (declared before running)

| arm | filter |
|---|---|
| A | ALL qualifying convex trades |
| B | predicted vol ≥ 50th percentile |
| C | predicted vol ≥ 70th percentile |
| D | predicted vol ≥ 90th percentile |

**Percentile thresholds are fitted on TRAINING data only and applied forward.** No full-dataset
percentiles, no future volatility, no in-progress candles.

### Controls — each one kills a specific alternative explanation

1. **Random filter** at arm C's trade count, fixed seeds. Tests whether any apparent improvement is
   just an artifact of trading less.
2. **Lagged realised volatility** in place of the model. Tests whether the ML model adds anything
   beyond the obvious "high volatility suits convexity" relationship.
3. **Direction blindness.** The direction model is not consulted anywhere.

## Ship bar — all five required

1. Beats unfiltered on **net EV per unit capital in ≥2 of 3 folds**
2. **Positive net EV in ≥2 of 3 folds**
3. Improvement **≥ +0.03R/trade** over unfiltered (guards against a statistically real but
   economically meaningless gain)
4. Trade count remains **≥10%** of the unfiltered strategy
5. The improvement **persists on the final untouched 20% holdout**

**Secondary:** is EV monotone rising across ALL → 50th → 70th → 90th? A collapse at the 90th with
the 70th best is also informative — it would indicate a nonlinear relationship.

## Reported per arm

net EV/trade · net EV per unit capital · Sharpe · trade count · win rate · 1R-loss rate ·
5R-win rate · max drawdown · turnover · total return

## Anticipated failure modes, named in advance

- **Failure A:** high volatility widens ADVERSE excursions too, so the 1R stop is hit more often and
  the gain cancels.
- **Failure B:** the tail gate already captures essentially all of the volatility information,
  making the filter redundant — the [[what-we-tried]] Mode 2 pattern.

## Why the outcome matters either way

A PASS would establish something stronger than "volatility is predictable": that volatility
prediction can identify **when an independently validated payoff structure has unusually favourable
economics** — turning a descriptive signal into a capital-allocation component.

A FAIL is still informative: it would show the model's predictive power does not translate into
better selection of convex opportunities, which bounds what the one surviving model is good for.
