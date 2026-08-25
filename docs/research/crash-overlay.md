# T8 — Crash-protection overlay on BTC buy-and-hold

**Status:** design pre-declared by the user before the run. Recorded with results appended.

## The question

Not "is T2 a good model" — it failed its own bar at AUC 0.637. The narrower question:

> Can even a WEAKLY predictive crash-risk signal be useful as an INSURANCE OVERLAY on buy-and-hold?

100% BTC spot. No leverage, no shorting, no options, no funding, no venue-restricted data. The model
never predicts direction — only whether drawdown risk is elevated. Cash earns the contemporaneous
3-month Treasury rate (DGS3MO, fetched from FRED; mean **4.11%** over the test period — omitting it
would have materially misstated the investor's real alternative).

Signal at daily close, position implemented next bar. Thresholds frozen before evaluation.

## RESULTS — run 2026-08-23

**1,652 days, 2021-12-21 → 2026-06-29.** Crash probability: 69% of days <30%, 18% in 30-50%,
13% >50%.

| arm | total | CAGR | maxDD | Calmar | Sharpe | Sortino | vol | u/w% | retain | ddCut |
|---|---|---|---|---|---|---|---|---|---|---|
| A: B&H control | 29% | 5.8% | **−69.0%** | 0.08 | 0.37 | 0.52 | 51% | 97% | 100% | 0% |
| B: light | 176% | 25.1% | −41.8% | 0.60 | 0.72 | 1.11 | 44% | 95% | 436% | 39% |
| C: moderate | 294% | 35.4% | −35.5% | 1.00 | 0.93 | 1.44 | 42% | 94% | 615% | 49% |
| **D: defensive** | **445%** | **45.5%** | **−30.9%** | **1.47** | 1.12 | 1.65 | 41% | 91% | 789% | **55%** |

**All three overlays pass all seven criteria.** Both mandatory controls support real timing value:

| control | B | C | D | vs real |
|---|---|---|---|---|
| **shuffled signal** (distribution kept, timing destroyed) | 0.04 | 0.01 | −0.02 | real 0.60 / 1.00 / 1.47 |
| **signal lagged 30 days** | 0.15 | 0.18 | 0.20 | real 0.60 / 1.00 / 1.47 |

Shuffling collapses Calmar to roughly buy-and-hold's 0.08 — consistent with reduced exposure spread
randomly, which just scales the benchmark down. A 30-day lag destroys most of the benefit. **The
signal's value is in its timing, not in the exposure reduction per se.** That is exactly what the
controls were written to distinguish, and it is the clearest positive control result in this vault.

Also correcting a real flaw found while running this: **T2's purge (48 bars) was SHORTER than its
60-bar label horizon**, so training labels bled into the test window. Re-run with purge 72: Calmar
1.50 → 1.47. The flaw was real but not load-bearing. *(T2's own reported AUC 0.637 carries the same
mild optimism.)*

## ⚠️ The caveat that bounds all of it: the window cannot test the case that would hurt

Walk-forward requires training data first, so **out-of-sample predictions do not begin until
2021-12-21 — immediately after the November 2021 peak.** Consequences:

1. **Buy-and-hold's test-period CAGR is 5.8% with a −69% drawdown.** Any strategy that reduces
   exposure during crashes wins enormously against that. The "retention" figures of 436–789% are
   **degenerate** — they divide by a near-zero denominator and should not be read as "retains 8× the
   return."
2. **The BULL window has NO OOS COVERAGE.** The mandatory robustness check cannot evaluate
   2020-01 → 2021-11, which is precisely where an exposure-reducing overlay would cost the most.
   This is a structural limit of walk-forward, not an oversight, but it means the strongest argument
   *against* the overlay is untestable here.

**The one bull-ish window with coverage is genuinely reassuring, though:** over RECOVERY
(2022-11 → 2025-10) buy-and-hold returned **+666%** and arm D returned **+467%** — retaining ~70% of
a large bull move while still cutting drawdown. That is the single most important number in this
document, because it is the only evidence that the overlay does not destroy upside.

| window | A (B&H) | B | C | D |
|---|---|---|---|---|
| FULL | +29% / −69% | +175% / −42% | +291% / −35% | +441% / −30% |
| BULL | *no OOS coverage* | — | — | — |
| BEAR 2022 | −66% / −69% | −33% / −42% | −7% / −30% | **+26% / −17%** |
| RECOVERY | **+666%** / −28% | +564% / −27% | +512% / −26% | **+467%** / −26% |
| LATE-BEAR | −51% / −52% | −40% / −41% | −33% / −35% | −26% / −30% |

## Honest verdict

**PASS on the pre-declared bar, and the controls are strong enough that I believe the timing value is
real** — shuffled and lagged signals both collapse, which no amount of window luck explains.

**But the magnitude is inflated by the window**, and the case that would most challenge the
hypothesis (a sustained bull) is untestable with walk-forward on this dataset. The defensible claim
is therefore:

> A weakly predictive crash signal carries genuine timing information, sufficient to remove roughly
> **40–55% of maximum drawdown** while retaining about **70% of return in the one bull window that
> could be measured**. The headline return figures are artifacts of a benchmark that round-tripped.

**This is the first result in the vault that is both positive and reachable** — no shorting, no
leverage, no options, no inaccessible venue, no forecast of direction. It answers the question the
user actually asked at the start, reframed: not *"up or down?"* but *"how much capital should be
exposed right now?"*

## Follow-up needed before trusting it

1. **Bull-window evidence.** Extend the archive backwards (2017-2019) so a walk-forward can produce
   OOS predictions across a full bull cycle.
2. **Turnover and taxes.** Not measured here. Exposure changes daily; in a taxable account that
   matters, and the frictionless assumption flatters the result.
3. **The retention metric needs a denominator that is not near zero** — report absolute CAGR against
   a long-horizon benchmark rather than a ratio.


---

## SHIPPED 2026-08-24

This was the most validated finding in the vault and was **not in the product at all** — no model
file, `crashProbability: null`, and a sizing curve explicitly marked "NOT fitted, NOT validated".
That gap is now closed.

- **`ml-model-crash-crypto.json`** — 870,093 bars, 77 symbols, the 110 serving features. Target
  frozen from T2: `P(fall >= 10% within 10 days)`. Base rate 40.9%; walk-forward AUC
  0.617 / 0.585 / 0.587 (mean 0.596); purge 72 > the 60-bar label horizon, the leak T8 recorded.
  Calibration is monotone and inspectable: 26.0% → 38.1% → 53.7% realised by bucket.
- **`VALIDATED_CURVE` replaces `PLACEHOLDER_CURVE`** — T8 arm D exactly (1.00 below 0.30, 0.50 to
  0.50, 0.00 above). **The zero is deliberate**: T15 measured that adding an exposure floor removes
  the benefit in proportion, so the "safer-looking" version is the worse one. A test pins the
  absence of a floor so it cannot be quietly added back.
- **Warnings lead the card, above any trade idea** — this is defensive, and it reaches the user on
  days when nothing is tradeable, which is exactly when it matters.
- **Every warning states the episodic caveat.** A user who sees it fire twice and then sit quiet
  through a 25% fall would reasonably conclude it was broken; absence of warning is a documented
  property of this signal, so the message says so on its face ("Quiet is not 'safe'").

The supported-ceiling discipline from the excursion export is applied here too: the calibration is
capped at the highest rate a 500-sample bucket actually realised (0.614, 1.5x base), so an isotonic
tail resting on a handful of points cannot cut position size to zero on thin evidence.
