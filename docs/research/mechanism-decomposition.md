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
