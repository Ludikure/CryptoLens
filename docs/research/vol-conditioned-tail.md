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

---

# RESULTS — run 2026-08-23

**24 crypto symbols with full 1h OHLC (2020-01 → 2026-07), 290,795 4H bars.** Real OHLC path
simulation as specified. Base rates: bigTail(72h≥5ATR) 19.9%, goodR(24h≥1.5ATR) 56.0%.

## Verdict: NOT SUPPORTED — all five numbered criteria PASS, and **both controls FAIL**

This is the case the controls were written for. Reported in that order deliberately.

### The numbered ship bar (arm D, vol ≥ 90th percentile)

| criterion | result | |
|---|---|---|
| 1. beats unfiltered in ≥2/3 folds | 3/3 | PASS |
| 2. positive net EV in ≥2/3 folds | 3/3 | PASS |
| 3. improvement ≥ +0.03R/trade | **+0.2088** | PASS |
| 4. trade count ≥10% of unfiltered | 22% | PASS |
| 5. persists on untouched holdout | **+0.2103** | PASS |

### The controls, which overturn it

| | walk-forward | **holdout** |
|---|---|---|
| arm D (model, vol ≥90th) | +0.5788 | **+0.6506** |
| **ctrl2: lagged REALISED vol ≥70th** | +0.5495 | **+0.7638** |
| delta (model − realised) | +0.029 | **−0.113** |

**Control 2 settles the hypothesis.** Its declared purpose was to determine whether the ML model adds
information beyond the obvious "high volatility suits convexity" relationship. It does not: a lagged
ATR percentile — one column, no model — matches the ML filter walk-forward (+0.029R, itself *below*
the design's own +0.03R materiality threshold) and **beats it outright on the holdout**.

**Control 1 is worse for the middle arms.** Random selection at matched trade count returns +0.3826
(WF) / +0.4143 (holdout), **beating arms B and C in both**. Filtering at the 50th and 70th percentile
is worse than not filtering at all.

### Monotonicity: NOT monotone

`ALL +0.3701 → 50th +0.3196 → 70th +0.3147 → 90th +0.5788`

No dose-response. Only the extreme tail helps, and realised volatility reaches it too — consistent
with "the top decile of volatility is a genuinely different state" rather than with the model
grading opportunity quality.

### Where the edge actually comes from — the tail gate, not volatility

Decomposing the averaged outcome into its legs, **ungated single-direction EV is −0.0441R**
(long −0.1033, short +0.0151; 5R hit rate 6.6%/6.7%). Every bit of the +0.37R in arm A comes from
the tail gate, which lifts realised bigTail from ~20% base to 42–67% in gated bars. The volatility
model is then filtering an already-filtered set, and adds nothing a lagged ATR percentile doesn't.

**This is Failure B, named in the design in advance:** *"the existing convex strategy already
captures essentially all of the volatility edge, making the filter redundant."*

### Caveats, including my own errors

- **The `5R-win%` column read 0.0 in every arm — my metric bug.** Direction-agnostic R is the MEAN of
  the long and short legs, so it can never reach 5.0. EV is unaffected (the mean of the two legs is
  exactly the EV of picking one at random, verified numerically), but the per-arm 5R rate in the main
  table is meaningless. Per-direction rates are reported above instead.
- **Absolute magnitudes do not reconcile with [[strategy-breakeven]]'s +0.151R gross.** This run shows
  +0.37R to +0.44R *net* on tail-gated trades. The likely cause is universe — 24 liquid majors here
  versus 77 symbols there — but it is **unresolved**, so these absolutes must not be quoted as
  tradeable. The control comparisons are relative and unaffected.
- **ctrl2 thins to n=199 on the holdout** (its threshold comes from the training distribution). Small,
  but it lands *above* the model arm, so it cannot be rescuing the model.
- 24 symbols, one 6.5-year period, same-bar stop/target ambiguity always charged as the stop.

### What this bounds

The volatility model remains the project's one validated predictive component — but its value is in
**describing how big a move may be, not in selecting when a convex payoff is worth deploying.** For
that job a lagged ATR percentile is as good or better, and free.

Had the numbered criteria been the whole test, this would have shipped as a finding. The controls are
what stopped it.
