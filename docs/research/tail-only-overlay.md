# T12 — Tail-risk-only overlay

**Status:** pre-declared by the user. No new features, no retraining, no threshold sweep. One
parameter declared by me: control 3's volatility ladder mirrors T9's structure (vol >80th → 50%,
>90th → 0%). Volatility percentiles are **expanding**, never full-sample.

**Rule:** activate T9's defensive exposure ONLY when crash probability > 30% **AND** 20-day realised
volatility exceeds its 80th percentile. Otherwise stay 100% invested.

## Verdict: DOES NOT MEET THE BAR — 3 of 6, and it destroys the thing it was protecting

| arm | CAGR | maxDD | Calmar | Sharpe | avg exp | turnover/y | episodes |
|---|---|---|---|---|---|---|---|
| BTC B&H | 36.8% | −76.6% | 0.48 | 0.83 | 100% | 0.0 | 0 |
| **T9 (prob only)** | **70.4%** | **−40.4%** | **1.74** | 1.42 | 73% | 34.9 | 122 |
| **T12 tail-only** | 45.0% | **−70.9%** | **0.63** | 0.95 | 96% | **6.8** | 23 |
| ctrl3: vol only | 38.3% | −74.9% | 0.51 | 0.87 | 94% | 4.5 | 17 |
| ctrl2: 30d lag | 46.9% | −53.3% | 0.88 | 1.08 | 73% | 34.5 | 120 |
| ctrl1: shuffled | 35.3% | −76.7% | 0.46 | — | — | — | — |

| criterion | result | |
|---|---|---|
| 1. Calmar > T9, or maxDD −5pp with CAGR kept | 0.63 vs 1.74; dd −70.9 vs −40.4 | **FAIL** |
| 2. turnover cut ≥30% | 6.8 vs 34.9 — an **80% cut** | PASS |
| 3. beats vol-only on Calmar | 0.63 vs 0.51 | PASS |
| 4. beats shuffled decisively | 0.63 vs 0.46 | **FAIL** |
| 5. survives holdout vs T9 | −0.46 vs −0.00 | **FAIL** |
| 6. no episode >50% of improvement | 34% | PASS |

## T12 solved the false-alarm problem completely — and that IS the failure

| episode | kind | BTC | T9 | **T12** | vol-only |
|---|---|---|---|---|---|
| 2020 H2 bull | bull | +582% | +405% | **+611%** | +544% |
| **2021 leg-2 bull** | bull | +110% | **+33%** | **+110%** | +110% |
| 2022-25 recovery | bull | +666% | +469% | +642% | +634% |
| 2021 crash | crash | −53% | **−32%** | −49% | −49% |
| **2022 bear** | crash | **−76%** | **+28%** | **−70%** | −74% |
| 2023 corrections | crash | −17% | −17% | −17% | −17% |
| 2024 corrections | crash | −24% | −20% | −24% | −26% |
| 2025-26 drawdown | crash | −51% | **−31%** | −50% | −52% |

T12 **fully captures every bull** — including the 2021 leg-2 advance that T9 missed (33% → 110%,
the exact problem T10 tried and failed to fix). And it gives back essentially all the crash
protection: the 2022 bear goes from **+28% to −70%**, against BTC's −76%.

Stress confirmation fires on only **5% of days** (crash p>30% alone fires on 35%), so average
exposure rises from 73% to 96%. The overlay becomes almost inert.

## The finding: T9's value is ANTICIPATORY, and confirmation destroys it

This is the mechanism, and it is obvious in hindsight:

**T9 protected the 2021 crash with 22-27 days of LEAD TIME** ([[t9-attribution-audit]] Test 3). It
acted *before* realised volatility rose. Requiring volatility to already exceed its 80th percentile
means waiting until the crash is visibly underway — by which point most of the loss has occurred.

The confirmation filter does not remove false alarms while keeping true ones. **It removes the lead
time, which was the entire source of value.**

## The null result the design anticipated, confirmed

The design named this outcome in advance: *"If volatility confirmation simply reproduces the
volatility-only control, then T9's apparent timing information is real, but the incremental
information is not economically useful."*

T12 (0.63) does beat vol-only (0.51) and shuffled (0.46) — so a little incremental information
survives — but the margin is small and it fails the "decisively" test. **Conditioned on observed
stress, the crash model adds almost nothing beyond what realised volatility already says.**

## What this establishes about T9

Combined with [[t9-attribution-audit]], the picture is now specific:

- T9's information is **real** (placebos collapse; forward drawdown monotone in exposure)
- It is **anticipatory** — its value lives in the 20-30 days before stress becomes observable
- It is **episodic** — it fires ahead of regime-level crashes, not ordinary 20% corrections
- **It cannot be made cheaper.** The turnover (34.9×/yr) and the false alarms are not separable from
  the lead time. T12 cut turnover 80% and lost 76% of the drawdown benefit.

That last point is the practical conclusion: **the cost of T9 is structural, not a tuning problem.**
Anyone using it accepts high turnover as the price of anticipation, or accepts a near-inert overlay.
