# After an extreme liquidation cascade, what happens next? — PRE-DECLARED DESIGN

**Status:** design frozen 2026-08-22, BEFORE any result. Listed as future work since 2026-07-10
("cascade-exhaustion / asymmetry WF tests"), never run for want of data.

## What makes this DIFFERENT from the rejected feature test

[[liquidation-features]] asked whether liquidation info improves `goodR` prediction **in general**,
and it failed on redundancy: trees fit the bulk of the distribution, where forced-flow magnitude
merely restates volatility already carried by `atrPercentile`, `volumeRatio` and `dAdx`.

This asks a **conditional tail** question a tree ensemble would not surface: *given an EXTREME
one-sided cascade has just occurred*, is what follows different from baseline? Two mutually
exclusive folk theories:

- **Exhaustion** — the cascade cleared the leverage; forward volatility DROPS and the move stalls.
- **Continuation** — the cascade is the start; forward volatility RISES and the move extends.

Both are widely asserted in trading commentary. Neither has been measured here.

## Data

Per-event CandleFeed liquidations (33 symbols, 2026-05-28 → 2026-08-21) joined to Binance Vision
1h klines. Tick resolution is required: daily aggregates cannot isolate the hour a cascade fired.

## Definitions

- **Cascade hour:** an hour whose one-sided liquidation notional exceeds that symbol's **99th
  percentile**, with the dominant side taking ≥70% of the hour's total (so it is genuinely
  one-sided, not two-way churn).
- **Forward window:** the 24 hours after the cascade hour closes. Strictly forward — no overlap.
- **Forward volatility:** realised high-low range over that window, in units of the symbol's
  trailing 24h ATR. Normalised so symbols pool.
- **Continuation:** signed forward return in the direction the cascade implies (long liquidations =
  down pressure; short liquidations = up pressure).
- **Baseline:** the same statistics over all non-cascade hours for that symbol.

## Ship bar — declared now

1. **Volatility effect:** forward realised range ≥ **1.25x** or ≤ **0.80x** baseline (either
   direction is a finding; near 1.0 is a null).
2. **Consistent across sides:** the effect holds for both long-side and short-side cascades — a
   one-sided-only result is confounded with crypto's long-heavy base rate.
3. **n ≥ 100** cascade hours per side.

Direction is reported **descriptively only**. Direction has been a coin flip on clean data across
every primitive tried here ([[rejected-hypotheses]]), and a positive direction result would be
treated as evidence of a bug before it was treated as an edge.

**Pre-registered expectation:** volatility RISES (continuation), because a cascade marks a
volatility regime and vol clusters — which would make it a restatement of ATR persistence rather
than news, i.e. true but useless. The genuinely interesting outcome is EXHAUSTION (<0.80x), because
that contradicts the momentum prior and would be actionable for stop and target placement.

## Known limitations (pre-declared)

~3 months, 33 symbols. Cascade hours cluster in time (a violent week supplies many), so episode
clustering must be checked before believing any interval — the same correction that mattered in
[[whale-trap-validation]].

---

## RESULTS

Run 2026-08-22. 32 symbols, **69,776 symbol-hours**. Baseline forward-24h range **5.38 ATR**.

### Verdict: NOT SUPPORTED — but the two sides move in OPPOSITE directions, which the design did not anticipate.

| cascade side | n | forward range | **ratio** | episodes | 95% CI (episode) | fwd return |
|---|---|---|---|---|---|---|
| **long flush** | 331 | 4.85 ATR | **0.90x** | 251 | **[0.85x, 0.93x]** | −0.78% |
| **short squeeze** | 102 | 6.92 ATR | **1.29x** | 74 | [0.99x, 1.37x] | +1.16% |

| pre-declared criterion | result | |
|---|---|---|
| ratio ≥1.25x or ≤0.80x | long 0.90x | **FAIL** |
| consistent across sides | opposite directions | **FAIL** |
| n ≥ 100 per side | 331 / 102 | pass |

### What actually happened

**Long flushes exhaust; short squeezes extend.** After an extreme long liquidation, forward
volatility runs ~10% BELOW baseline, and the episode-level CI **[0.85x, 0.93x] excludes 1.0** — so
the exhaustion effect is real, just smaller than the 20% the bar required. After an extreme short
squeeze it runs 29% ABOVE baseline on raw hours, though the episode CI [0.99x, 1.37x] grazes 1.0
and n=74 episodes is thin, so that side is suggestive rather than established.

**The design's criterion 2 assumed symmetry and was wrong.** I required the effect to hold on both
sides, treating a one-sided result as confounded with crypto's long-heavy base rate. The data says
the sides genuinely differ in SIGN, which that criterion cannot express. **The bar was not
re-interpreted to rescue the result** — it fails as written — but the assumption behind it is worth
recording as the thing to fix if this is ever re-run: test the sides separately, with separate bars.

This asymmetry is the third independent time the short side has behaved differently from the long
side in this vault ([[whale-trap-validation]]: short-crowding predicts liquidations at 18pp while
long-crowding manages 4.8pp; [[liquidation-map]]: comparable intensities but different tails). A
consistent pattern across three unrelated tests is worth noting even though none of them
individually cleared its bar.

### Direction — descriptive ONLY, as pre-declared

Forward returns run in the cascade's direction on both sides (−0.78% after long flushes, +1.16%
after short squeezes). **This is not a tested claim**, carries no significance test, and must not be
built on: direction has collapsed to a coin flip on clean data across every primitive tried here,
and the one time it looked strong it was [[edge-leak-daily-candle]].

### Not shipped

No prompt or model change. The measured exhaustion is ~10% of a volatility baseline that already
varies far more than that hour to hour — too small to change a stop or a target, which is the only
place it could have mattered.
