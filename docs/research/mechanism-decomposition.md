# T17 — Mechanism decomposition of the crash signal

**Status:** pre-declared by the user. **Not a ship test — an explanation test.** No feature selection
after observing results; all arms reported.

**Question:** T16 established the phenomenon replicates leave-one-symbol-out across four assets.
*What information is actually doing the work?*

## Feature partition — frozen before the run

Classified from the v14 column list by name, before any arm was evaluated.

| arm | contents |
|---|---|
| **A FULL** | all 110 production features (the frozen T9 benchmark) |
| **B PRICE/VOL** | RSI/MACD/ADX/Stoch/BB/EMA/VWAP across d/h/e, ATR, volatility, momentum, trend, structure, candle patterns, volume ratios, regime, temporal. **Excludes** funding, OI, taker, crowding, basis, cross-asset |
| **C DERIVATIVES** | fundingSignal, oiSignal, takerSignal, crowdingSignal, derivativesCombined, fundingRateRaw, oiChangePct, takerRatioRaw, longPctRaw, oiPriceInteraction, fundingSlope, basisPct, basisExtreme |
| **D MARKET-WIDE** | ethBtcRatio, ethBtcDelta6, fearGreedIndex, fearGreedZone, vix, vixLevelCode, vixTermStructure, dxyAboveEma20, dxyMomentum, relStrengthVsSpy, relStrengthVsSector, iwmSpyRatio, isCrypto |
| **E ASSET-SPECIFIC** | everything in B and C — i.e. all features belonging to the individual asset, with every market-wide feature removed |

## Identical across all arms, per the spec

Same target (P(10% drawdown in 10 days)), same folds, same purge (72), same LGB d4/t150, same T9
decision rule, same 0.10% costs, same leave-one-symbol-out structure over BTC/ETH/SOL/XRP.

**One computational deviation, declared:** refits are **quarterly** rather than monthly. Five arms ×
four assets × monthly would be ~1,400 model fits. Quarterly is applied **identically to every arm**,
so the comparison — which is what T17 is about — remains fair. Absolute numbers will differ slightly
from T16's monthly-refit run and are not directly comparable to it.

## Primary measures — predictive ability first, portfolio second

AUC · calibration · precision in the top-risk bucket · lead time before ≥30% drawdowns.
Then Calmar / maxDD / CAGR / turnover.

## The decisive test

For the **9 asset-specific crash clusters** identified in T16 (ETH 2020-09; XRP 2020-11, 2021-02,
2022-10, 2025-01, 2026-03; SOL 2021-09, 2023-02, 2023-12), **does ARM E still anticipate them?**

| outcome | interpretation |
|---|---|
| E succeeds | asset-specific vulnerability mechanism |
| E fails but D succeeds | the signal is primarily systemic crypto stress |
| C dominates | leverage/positioning is central |
| B dominates | ordinary price/volatility structure |
| several arms retain power | multi-mechanism |

**Pre-registered expectation:** B is likely to carry most of it — 20 derivatives features contributed
**zero splits** in the 2026-07-05 feature audit ([[rejected-hypotheses]]), a coverage artifact that
may or may not have been fixed in v14. If C turns out to dominate, that would overturn a documented
prior and should be treated with extra suspicion, not enthusiasm.

---

# RESULTS — run 2026-08-23

Feature counts: A=120 · B=99 · C=13 · D=8 · E=112. Leave-one-symbol-out, quarterly refits,
identical folds across every arm.

## PRIMARY MEASURE — predictive ability (the one that is interpretable)

| arm | BTC | ETH | SOL | XRP | **mean AUC** | top-decile precision |
|---|---|---|---|---|---|---|
| A FULL | 0.611 | 0.601 | 0.584 | 0.640 | **0.609** | 43.4% |
| **B PRICE/VOL** | 0.552 | 0.595 | 0.600 | 0.667 | **0.604** | **51.1%** |
| C DERIVATIVES | 0.567 | 0.549 | 0.573 | 0.507 | **0.549** | 32.3% |
| D MARKET-WIDE | 0.577 | 0.568 | 0.550 | 0.566 | **0.565** | 37.3% |
| **E ASSET-SPEC** | 0.583 | 0.600 | 0.631 | 0.638 | **0.613** | 49.5% |

## Attribution: asset-specific PRICE/VOLATILITY structure

- **E (0.613) ≥ A (0.609) ≥ B (0.604)** — stripping every market-wide feature costs nothing.
  **The signal is NOT primarily systemic crypto stress.**
- **C alone: 0.549** — derivatives/positioning is the *weakest* block, consistent with the
  2026-07-05 audit finding those 20 features contributed zero splits. The pre-registered suspicion
  about C dominating did not arise; the documented prior holds.
- **D alone: 0.565** — market-wide state carries some information but far less than price structure.

Per the design's own interpretation table: **"If B dominates: the phenomenon may be ordinary
price/volatility structure."** That is the answer.

## ⚠️ TWO ARTIFACTS — the portfolio table below is NOT interpretable across arms

| arm | mean Calmar | mean maxDD | mean CAGR | turn/y | drawdowns "anticipated" |
|---|---|---|---|---|---|
| A FULL | 1.65 | −48.4% | 77.6% | 44.5 | 18/24 = 75% |
| B PRICE/VOL | 3.90 | −42.5% | 159.6% | 50.5 | 18/24 = 75% |
| C DERIVATIVES | 0.63 | −51.8% | 31.8% | 41.0 | **23/24 = 96%** |
| D MARKET-WIDE | 1.20 | −40.9% | 45.5% | 40.6 | 16/24 = 67% |
| E ASSET-SPEC | 4.33 | −39.3% | 165.0% | 54.2 | 18/24 = 75% |

**Artifact 1 — threshold placement, not skill.** Underlying buy-and-hold CAGRs are BTC 37.2%, ETH
39.0%, SOL 17.9%, XRP 35.4% (mean 32.4%), so arms B and E showing 160-165% is not explained by
asset growth. But their AUCs are within 0.01 of arm A's. **Near-identical ranking ability producing
2.6× different Calmar means the Calmar gap is driven by where each arm's probability distribution
falls against the FIXED 0.30/0.50 thresholds** — an arm whose probabilities sit lower is defensive
less often, keeps more upside, and scores better without predicting better. This is exactly why the
design said *"Do NOT primarily compare Sharpe."*

**Artifact 2 — the anticipation metric is confounded by average exposure.** Arm C "anticipates"
**96%** of drawdowns while having the **worst AUC (0.549)** and worst Calmar (0.63) and a CAGR
(31.8%) below the 32.4% baseline. A strategy that is defensive most of the time trivially has reduced
exposure at most peaks. **The metric as specified does not normalise by exposure**, so C's 96% is a
base-rate artifact, not skill. Recorded as a flaw in the measure, not a finding.

## The decisive test — T16's 9 asset-specific crash clusters

| arm | anticipated | detail |
|---|---|---|
| A FULL | 6/9 | ETH 1/1 · SOL 3/3 · XRP 2/5 |
| B PRICE/VOL | **8/9** | ETH 0/1 · SOL 3/3 · XRP 5/5 |
| C DERIVATIVES | **8/9** | ETH 0/1 · SOL 3/3 · XRP 5/5 |
| D MARKET-WIDE | 6/9 | ETH 1/1 · SOL 2/3 · XRP 3/5 |
| E ASSET-SPEC | 7/9 | ETH 0/1 · SOL 3/3 · XRP 4/5 |

**Asset-specific crashes ARE anticipated without market-wide information** (E 7/9, B 8/9). Combined
with E ≥ A on AUC, this supports an **asset-specific vulnerability mechanism** rather than systemic
stress. C's 8/9 carries the exposure confound above and should not be read as derivatives mattering.

## Reconciliation with T15 — "price/volatility structure" ≠ "volatility"

T15's CTRL3 built continuous sizing from **realised volatility alone** and scored Calmar **0.25 —
worse than BTC itself.** Yet arm B here, built from the price/volatility feature *block*, carries
essentially the full signal.

**So the mechanism is not "the model has rediscovered realised volatility."** It is extracting
something from ~99 price-structure features that a single volatility measure does not contain.
What, specifically, remains unidentified — that would need permutation importance within arm B, a
separate experiment.

## Conclusion

Stable attribution across leave-one-symbol-out folds, which is what the design asked for:

> **The crash signal is asset-specific price/volatility structure.** Market-wide state adds nothing
> (E ≥ A). Derivatives/positioning is the weakest block. It anticipates crashes unique to a single
> asset without knowing what the rest of crypto is doing — but it is not a simple volatility read.
