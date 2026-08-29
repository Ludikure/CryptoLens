# Do forced-liquidation features improve ML_WIN? — PRE-DECLARED DESIGN

**Status:** design frozen 2026-08-22, BEFORE any result was computed.
**Origin:** a CandleFeed subscription recovered the liquidation history our own collector never
captured. Question: can the model use it? This is that test.

> Everything below "RESULTS" was written after the numbers came back; everything above it before.
> See `edge-methodology`, and [[news-catalyst-test]] for the most recent instance of this pattern.

## What is and isn't testable

| dataset | training-window coverage | verdict |
|---|---|---|
| Tick-level per-event liquidations | **33 days overlap = ~1.4% of bars** | **NOT TESTED.** Worse than the 1-2.5% derivatives coverage the 2026-07-05 audit blamed for those features earning zero splits. Adding it would reproduce a failure mode we have already diagnosed. Keep it for the cascade/heatmap work, not the model. |
| Aggregated DAILY liquidations | **100% of bars on 12 of 77 symbols**, back to 2019-09-25 | **THIS TEST.** |

The 12: ADA, AVAX, BNB, BTC, DOGE, DOT, ETH, LINK, LTC, SOL, UNI, XRP.

## Leak control — the thing most likely to produce a fake result

A day's liquidation total includes events that occur AFTER an early bar in that same day. Joining
same-day totals to intraday bars leaks the future into the features. **This is structurally
identical to the in-progress-daily-candle leak that inflated the crypto direction model to a fake
~94% and had to be retracted (2026-06-02, [[edge-leak-daily-candle]]).**

Therefore: **a bar on UTC date D may only see liquidation data from D-1 or earlier.** No exceptions,
no same-day values, enforced in the join rather than audited afterwards. The script asserts that the
maximum liquidation-date used is strictly less than the bar's own date, and aborts if not.

## Candidate features (all prior-day)

| feature | rationale |
|---|---|
| `liqTotalUsdLog_prev` | log1p(long+short USD) — cascade magnitude |
| `liqAsymmetry_prev` | (short-long)/(short+long), -1..+1 — **the one thing plausibly NOT already in the model.** Aug 19 2026 was $311M shorts vs $11M longs (27:1); nothing in the current 110 features encodes directional forced-flow imbalance |
| `liqZScore_prev` | prior day total vs trailing 30d mean/sd — "unusually violent day" independent of symbol scale |
| `liqShareOfOI_prev` | liquidated USD / open interest USD — cascade size relative to positioning |

## Method — mirrors `calibrate_v14.py` exactly

Same fold boundaries (`train_end = n·(0.4+0.15i)`, 3 folds, expanding), same 48-row purge, same
canonical daily downsample (`groupby(symbol,date).tail(1)`), same time-decay weights (last year 3x,
last 2 years 2x), same model (LightGBM d4/t150/lr0.03). Only the feature set differs.

- **Baseline:** the 110 production features, restricted to the 12 symbols.
- **Treatment:** baseline + the 4 liquidation features.

Restricting the baseline to the same 12 symbols is essential — comparing a 12-symbol treatment
against the 77-symbol production model would confound the feature with the universe.

## Ship bar — declared now

To justify a v15 retrain incorporating liquidation features, ALL must hold:

1. Mean ΔAUC (treatment − baseline) **> +0.005**
2. ΔAUC **positive in ALL 3 folds**
3. The liquidation features earn **≥ 2% of total tree splits** (they must actually be used — the
   2026-07-05 audit's diagnostic; derivatives currently earn 0.82% despite ~100% coverage)

This is the project's standing bar, unchanged from the v14 challenger evaluation. Anything less is
written up as **not supported** and filed in [[rejected-hypotheses]].

**Pre-registered expectation:** I expect this to FAIL, at roughly 1-in-3 odds of clearing. A large
liquidation day IS a large move day, and the model already carries ATR percentile, volume ratio,
ADX and OI change. That is exactly why whale features were rejected in July — real univariate
signal (~0.57 AUC) that proved wholly redundant with existing volume/volatility features. Forced
flow is the same family. `liqAsymmetry` is the only genuinely novel input, and it is one feature
against 110.

## Known limitations

- **12 of 77 symbols.** A positive result would only license the feature for majors, or require
  a majors-only model — itself a change worth measuring separately.
- **Sampling cap:** the aggregated series derives from the same public stream Binance caps at one
  event/second/symbol. All magnitudes are lower bounds. Consistent across time, so ranking should
  survive, but absolute thresholds mean less than they appear to.
- **Daily granularity** against 4H bars: the prior-day value is constant across a day's six bars,
  so it is a slow-moving feature by construction.

---

## RESULTS

Run 2026-08-22 (`ml-training/liquidation_feature_test.py`). 12 declared symbols, **26,416 daily
bars**, goodR base 0.503, feature coverage 89.4%.

### Verdict: NOT SUPPORTED — the features are USED but carry no incremental information.

| fold | baseline AUC | +liquidations | Δ |
|---|---|---|---|
| 0 | 0.6856 | 0.6877 | **+0.0022** |
| 1 | 0.6668 | 0.6665 | −0.0002 |
| 2 | 0.6858 | 0.6857 | −0.0001 |
| **mean** | **0.6794** | **0.6800** | **+0.0006** |

| pre-declared criterion | result | |
|---|---|---|
| mean ΔAUC > +0.005 | **+0.0006** | FAIL |
| positive in ALL folds | 1/3 | FAIL |
| split share ≥ 2% | **4.64%** | pass |

### The interesting part: criterion 3 PASSED

The trees allocate 102 of 2,199 splits (4.64%) to the four liquidation features — **more than the
entire 20-feature derivatives group earns in production (0.82%)**. So this is NOT the coverage
artifact the 2026-07-05 audit diagnosed. The model genuinely reaches for these features, and the
AUC still does not move.

That combination is the signature of **redundancy, not absence of signal**: the trees use forced-flow
magnitude as a substitute for volatility information they already hold in `atrPercentile`,
`volumeRatio`, `dAdx` and `oiChangePct` — and substituting adds nothing. It is precisely the whale
-feature result again ([[rejected-hypotheses]], 2026-07-05: standalone AUC ~0.57, entirely redundant
with existing volume/ATR/ADX/derivatives features). Forced flow is the same family, and it fails the
same way.

`liqAsymmetry_prev` — the one input I argued was genuinely novel, since nothing in the 110 encodes
directional forced-flow imbalance — earned 22 splits and did not rescue the result. Even a 27:1
short-to-long day (2026-08-19: $311M vs $11M) apparently tells the model nothing it cannot already
infer.

### Execution note (deviations, both corrected before the result was accepted)

The first run deviated from this design in two ways and was re-run: it loaded **all 33** symbols in
the directory rather than the declared 12 (the 21 shallow ones start 2026-03-19 and diluted coverage
to 45.6%), and `liqShareOfOI_prev` silently built as **all-zero** because the v14 CSVs have no
`openInterestUsd` column — a dead feature masquerading as a tested one. Both were fixed and the test
re-run as written. **The first run also failed** (mean ΔAUC +0.0008, 2/3 folds, 1.57% splits), so the
conclusion is unchanged either way; recorded because a silently-dead feature is exactly the kind of
thing that turns a null into a false null.

### What this does and does not license

- **Do NOT add liquidation features to v15.** Rejected on the pre-declared bar.
- **Does NOT devalue the CandleFeed purchase.** Tick data was never the candidate here (33-day
  overlap, ~1.4% of bars) and remains the input for the liquidation-heatmap work — where the
  question is "where do cascades occur relative to predicted clusters", not "does yesterday's
  cascade predict tomorrow's move".
- **Does NOT test intraday.** Only prior-DAY aggregates were tested, because that is all that is
  leak-safe at daily granularity. A 4H-bucket liquidation feature would be a different experiment,
  needs the tick data to mature, and inherits the same redundancy prior.
