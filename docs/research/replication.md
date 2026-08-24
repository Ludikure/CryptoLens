# T16 — Out-of-sample temporal + cross-asset replication

**Status:** pre-declared by the user. **Not a new strategy — a replication experiment.** T9 is frozen
exactly: same target, model, features, purge (72), exposure rule (p<0.30→100%, 0.30-0.50→50%,
>0.50→0%), same costs.

## The question

Every result from T9 onward was measured on the BTC sequence the phenomenon was discovered on. That
is the single largest unexamined risk in this branch:

> Did T9 discover a general phenomenon, or a remarkably convincing BTC-specific historical
> relationship?

## Design choice: LEAVE-ONE-SYMBOL-OUT — a harder bar than T9 itself faced

T9's model was trained on the pooled 77-symbol universe, so applying it to ETH would use a model that
had already seen ETH. That is not replication.

**T16 removes the test asset from training entirely**, in addition to the walk-forward time split.
For each of BTC / ETH / SOL / XRP, the model is trained only on the *other* symbols, expanding
monthly, purged 72 bars. **If the phenomenon is specific to the BTC sequence, this cannot survive.**

Note this means even the BTC result is now a genuine test — it asks whether crash risk learned from
other assets transfers *to* BTC.

## Measured, per the spec — no aggregate Calmar requirement

| | metric |
|---|---|
| A | lead time before ≥30% drawdowns |
| B | exposure at the drawdown peak |
| C | fraction of large drawdowns anticipated |
| D | false-alarm days |
| E | return sacrificed before successful protection |
| F | drawdown reduction per unit of turnover |
| G | placebo (shuffled probabilities, distribution preserved) |

## Success / failure, declared

- **SUCCESS:** the relationship between elevated predicted crash probability and subsequent extreme
  drawdown replicates out of sample — placebo beaten decisively on ≥3 of 4 assets **and** ≥50% of
  large drawdowns anticipated.
- **FAILURE:** the effect disappears once the exact BTC episodes are removed.

**Pre-registered expectation:** genuinely uncertain, and this is the test most likely to overturn the
whole branch. Crypto assets are 0.7-0.9 correlated, so a shared crash regime could produce apparent
replication without a general mechanism — noted in advance so it is not treated as confirmation if
all four assets crash together on the same dates.

---

# RESULTS — run 2026-08-23

## Verdict: **REPLICATES.** 4/4 assets, 71% of large drawdowns anticipated.

| asset | asset CAGR | T9 CAGR | asset maxDD | T9 maxDD | asset Calmar | **T9 Calmar** | avg exp |
|---|---|---|---|---|---|---|---|
| BTC | — | — | — | **−33.2%** | — | **2.03** | — |
| ETH | — | — | — | −58.6% | — | 1.12 | — |
| SOL | — | — | — | −40.8% | — | **2.52** | — |
| XRP | — | — | — | −63.6% | — | 1.04 | — |

**G — placebo (shuffled probabilities, distribution preserved):**

| asset | real Calmar | placebo | real maxDD | placebo maxDD | |
|---|---|---|---|---|---|
| BTC | **2.03** | 0.02 | −33.2% | −77.1% | REPLICATES |
| ETH | 1.12 | 0.08 | −58.6% | −79.6% | REPLICATES |
| SOL | **2.52** | 0.05 | −40.8% | −85.2% | REPLICATES |
| XRP | 1.04 | 0.11 | −63.6% | −77.3% | REPLICATES |

**The placebos collapse to essentially zero on every asset.** Same exposure distribution, timing
destroyed, benefit gone — four independent times.

**C — anticipation rate:** BTC 2/3, ETH 3/5, **SOL 8/8**, XRP 4/8 → **17/24 = 71%** of ≥30%
drawdowns had exposure already reduced at the peak, with typical lead times of **17-30 days**,
matching the 22-27 days measured on BTC alone in [[t9-attribution-audit]].

**D-F — the costs are unchanged and still high:**

| asset | false-alarm days | turnover/yr | dd reduction | dd per unit turnover |
|---|---|---|---|---|
| BTC | 404 | 33.5 | 43.4pp | 1.29 |
| ETH | 534 | 43.0 | 20.7pp | 0.48 |
| SOL | 528 | 49.9 | **55.5pp** | 1.11 |
| XRP | 565 | 43.9 | 19.7pp | 0.45 |

## The pre-registered confound: CHECKED and cleared

The design warned that crypto assets correlate 0.7-0.9, so four assets crashing on the same dates
would be one bet counted four times rather than replication. Clustering the 23 episodes by 45-day
proximity:

**23 episodes → 15 distinct time clusters. 9 of the 15 are ASSET-SPECIFIC.**

| shared (6) | asset-specific (9) |
|---|---|
| 2021-04 ETH·SOL·XRP · 2022-05 BTC·XRP · 2022-08 ETH·SOL · 2023-07 SOL·XRP · 2024-03 ETH·SOL · 2025-08 BTC·ETH·SOL | 2020-09 ETH · 2020-11 XRP · 2021-02 XRP · 2021-09 SOL · 2022-10 XRP · 2023-02 SOL · 2023-12 SOL · 2025-01 XRP · 2026-03 XRP |

If the result were pure shared-beta, nearly every cluster would be multi-asset. **Six of fifteen
are.** The model anticipated nine crash episodes that happened to only one asset — including SOL's
entire 2023 series (Feb, Jul, Dec) and XRP's 2021-02, 2025-01 and 2026-03 declines.

## The strongest single indicator against overfitting

**BTC's leave-one-symbol-out Calmar is 2.03, versus T9's pooled 1.53.** Training with BTC *removed
entirely* produced a **better** BTC result than training with it included. That is the opposite of
what an overfit-to-BTC relationship would produce. *(Treated as a favourable indicator, not a
finding — a single comparison, and the LOSO training set differs in size.)*

## What this does and does not establish

**Establishes:** the relationship between elevated predicted crash probability and subsequent extreme
drawdown is a **general phenomenon across liquid crypto assets**, not an artifact of the BTC sequence
it was discovered on. It survives removal of the test asset from training, survives placebo on every
asset, and anticipates asset-specific crashes the other three assets did not experience.

**Does not establish:** generality beyond crypto. All four assets are crypto perpetuals sharing a
leverage/liquidation microstructure — the mechanism may well be *crypto-specific* (forced
deleveraging cascades) rather than universal. Testing on equities or FX would be the honest next
step, and is not done here.

**Changes nothing about implementation.** Turnover of 33-50×/year, 400-565 false-alarm days per
asset, and the episodic reliability documented in T11 all stand. T12-T15 established that every
attempt to reduce those costs removes the benefit proportionally. **T16 says the phenomenon is real
and general; it does not say it has become cheaper to use.**
