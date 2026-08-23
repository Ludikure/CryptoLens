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
