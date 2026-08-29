# T6 — Risk-premium regime rotation — PRE-DECLARED DESIGN

**Status:** frozen 2026-08-23, BEFORE any result. Hypothesis specified by the user. Two things the
spec left open — the **ship bar** and the **controls** — are declared here by me, in advance, and are
flagged as mine.

## The hypothesis

Do not predict price. Predict **which already-validated economic mechanism is currently being
compensated most generously**, and allocate to it.

> "Can we predict which already-observed economic mechanism is currently being compensated most
> generously?"

No new features. No directional prediction. No re-tuning of any component strategy.

## The six exposures — each frozen at its ALREADY-MEASURED parameterisation

| # | exposure | source | note |
|---|---|---|---|
| 1 | Convex tail | T5 tail-gated 1R/5R, 72h, OHLC simulator | [[vol-conditioned-tail]] |
| 2 | Cash-and-carry | funding harvest, delta-neutral | [[funding-carry]] — Binance rates |
| 3 | Trend | 200D EMA + 20d slope regime rule | [[regime-hold]] |
| 4 | Defensive cash | 0% return | conservative; no T-bill yield credited |
| 5 | Volatility selling | 30d straddle sold, loss capped 3× premium | [[five-hypotheses]] H5 — BTC/ETH only, from 2021-03 |
| 6 | Spot buy & hold | equal-weight crypto | the benchmark that has beaten everything |

**Comparability choice (mine, declared):** the convex strategy produces R-units, not percentages. It
is converted at **1% of capital risked per trade**, so 1R = 1%. Sharpe is scale-invariant, so the
allocator's *ranking* does not depend on this constant — but reported magnitudes do.

## The allocator

At each monthly rebalance, rank the six by **trailing risk-adjusted performance over a 90-day
lookback**, using information available at that date only, and allocate to the top-ranked exposure.
No optimisation of the lookback or the rebalance period after seeing results.

This is deliberately the simplest possible estimator. **Note what it actually is: performance
chasing.** "What has paid recently will pay next" is itself a prediction claim, and it is the claim
under test.

## Controls — declared by me, because the spec omitted them and T5 showed why they decide the outcome

1. **EQUAL-WEIGHT all six.** The decisive control. If rotation cannot beat holding all six in equal
   proportion, the *selection* adds nothing and only the diversification did. This is T6's analogue
   of T5's realised-vol control, which overturned a 5-of-5 pass.
2. **RANDOM rotation**, fixed seeds, same turnover. Tests whether any gain comes from switching at
   all rather than from switching *correctly*.
3. **Best single strategy ex-post.** Unachievable upper bound; states how much was available.
4. **Buy-and-hold alone**, since it has beaten every active strategy tested so far.

## Ship bar — declared by me, all five required

1. Beats **equal-weight** on Sharpe in **≥2 of 3** folds
2. Beats equal-weight on **Calmar** (this is a drawdown claim as much as a return claim)
3. Beats **random rotation** on Sharpe
4. **Positive** total return in **≥2 of 3** folds
5. The advantage over equal-weight **persists on the final untouched 20% holdout**

Criterion 1 is the one that matters. A rotation that beats buy-and-hold but loses to equal-weight has
demonstrated diversification, not prediction.

## Anticipated failure modes, named in advance

- **A — performance chasing.** Strategy returns mean-revert across regimes, so a trailing window buys
  the exposure just as its premium is exhausted. This is the base case and the literature is not kind
  to it.
- **B — equal-weight wins.** The six are imperfectly correlated, so holding all of them may capture
  most of the benefit with none of the timing risk. That would be a real finding: *diversify across
  mechanisms, don't rotate between them.*
- **C — one exposure dominates the sample.** With six years and a crypto-heavy period, carry or hold
  may simply win throughout, making "rotation" a slow proxy for a static choice.

## Known limitations, stated up front

Six years is short for regime rotation. Vol-selling covers BTC/ETH only and starts 2021-03. Carry is
priced at Binance, which the user cannot access ([[funding-carry]]) — so a PASS here would be a
research finding about mechanism rotation, **not a tradeable allocation**.

---

# RESULTS — run 2026-08-23

1,916 days (2021-04-01 → 2026-06-29), the window where all six exposures exist.

## Verdict: DOES NOT MEET THE BAR — 3 of 5 criteria, and it loses to the control that matters

| arm | total | CAGR | maxDD | Sharpe | Calmar |
|---|---|---|---|---|---|
| **T6 ROTATION** | 20.4% | 3.6% | −35.1% | 0.69 | **0.10** |
| **ctrl1: EQUAL-WEIGHT** | **139.3%** | 18.1% | **−17.2%** | **1.17** | **1.05** |
| ctrl2: random rotation | 90.4% | 13.1% | −36.0% | 0.68 | 0.36 |
| ctrl4: buy & hold | 7.8% | 1.4% | −80.6% | 0.40 | 0.02 |

| criterion | result | |
|---|---|---|
| 1. beats equal-weight Sharpe ≥2/3 folds | 2/3 | PASS |
| 2. beats equal-weight on Calmar | **0.10 vs 1.05** | **FAIL** |
| 3. beats random rotation | 0.69 vs 0.68 | PASS (a tie) |
| 4. positive in ≥2/3 folds | 2/3 | PASS |
| 5. persists on holdout | **−4.37 vs +1.21** | **FAIL** |

**Failure B, named in the design, is confirmed: diversify across mechanisms, do not rotate between
them.** Equal-weight returns 7× the rotation with half the drawdown and a Calmar ten times better.

**Rotation is statistically indistinguishable from random switching** — 0.69 vs 0.68. Criterion 3
"passes" on a margin of 0.01, which is not evidence of skill; it is evidence the selection rule
contributes nothing. This is the same shape as [[vol-conditioned-tail]]'s control result.

**Fold Sharpes expose the mechanism:** rotation +3.71 / +4.54 / **−3.77** against equal-weight's
+0.94 / +1.53 / +1.24. Performance chasing worked while one premium persisted and then inverted
violently — precisely Failure A. The holdout is where it inverted.

The allocator spent most of its life in carry (1,278 of 1,916 days), so "rotation" was largely a slow,
lagged proxy for a static choice — Failure C as well.

## ⚠️ The exposure-level magnitudes are NOT trustworthy

| exposure | total | CAGR | maxDD | Sharpe |
|---|---|---|---|---|
| convex | 577.8% | 44.0% | −26.5% | 3.01 |
| carry | 75.6% | 11.3% | −3.0% | 4.78 |
| volsell | 52.3% | 8.4% | −31.0% | 1.12 |
| hold | 7.8% | 1.4% | −80.6% | 0.40 |
| trend | 20.0% | 3.5% | −74.4% | 0.35 |

**Two of these must not be quoted:**

- **convex** inherits [[vol-conditioned-tail]]'s unreconciled absolute EV (+0.37R measured there
  versus the trustworthy +0.151R *gross* / −0.008R *net* in [[strategy-breakeven]]). A Sharpe of 3.01
  and a 577% return directly contradict the established finding that this strategy is roughly
  break-even at the user's fees. Treat the series as a *shape*, not a magnitude.
- **carry** is priced at Binance funding, which the user cannot access, and its −3.0% drawdown
  excludes venue risk entirely — the FTX-shaped hole a funding series cannot show ([[funding-carry]]).

**The relative conclusion survives all of this**, because rotation and equal-weight are computed from
the *same* series: whatever the magnitudes, selecting among them loses to holding all of them.

## What is worth taking from this

The equal-weight arm posts Sharpe 1.17 at −17.2% drawdown against buy-and-hold's 0.40 at −80.6%.
Even discounting the two contaminated exposures, **spreading across imperfectly-correlated
MECHANISMS did far more than timing between them** — and it required no prediction of any kind.

That is consistent with everything else in [[what-we-tried]]: the value sits in structure and
diversification, not in forecasting which structure is about to pay.

**Follow-up worth doing** (not run here, and it would need its own frozen design): re-run equal-weight
with the convex series rebuilt at the trustworthy −0.008R net and carry priced at Coinbase's covered
basis. If it still beats buy-and-hold on Calmar, that is a real and reachable finding.
