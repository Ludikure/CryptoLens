# T19 — Can a simple momentum/regime index replace the ML model?

**Status:** pre-declared. **Attribution experiment, not a strategy hunt.** No threshold optimisation,
no weight optimisation, no converting the winner into a strategy.

**Question:** does the ML model contain predictive information beyond a fixed, pre-registered
combination of its surviving TREND/MOMENTUM inputs (T18's only load-bearing block)?

## The score — every formula frozen here, before any result

Inputs drawn ONLY from T18's TREND/MOMENTUM block. Standardisation is an **expanding** z-score per
asset (mean and sd from history to date only — no lookahead, no fitting).

| term | definition |
|---|---|
| **M1** short-term momentum | `\|z(hRsi − 50)\|` |
| **M2** medium-term momentum | `\|z(dRsi − 50)\|` |
| **M3** momentum acceleration | `\|z(hRsiAccel)\|` |
| **M4** trend strength | `z(dAdx)` |
| **M5** oscillator/extreme state | `\|z(dStochK − 50)\|` |

**SCORE = mean(M1..M5)** — equal weights, no fitting, no selection.

**Sign orientation, declared on economics not results:** crash risk rises with the *magnitude* of
momentum extension, not its direction — hence absolute deviations on M1/M2/M3/M5, and raw z on M4
(higher ADX = more extended trend). This follows T18's conclusion that *elevated and accelerating
momentum-indicator activity precedes extreme drawdowns*.

## Arms

A. T18 ML model (arm B feature set) · B. the simple score · C. realised-volatility only ·
D. 200D trend · E. shuffled score

## Ship bar — the margin, declared now

The ML model earns credit for **additional** information only if **all** hold:

1. **AUC(ML) − AUC(simple) ≥ +0.020** (T18 called +0.015 over a one-line rule "not material"; this
   sets the bar just above that)
2. The advantage survives LOSO — present on **≥3 of 4** assets
3. The simple score beats realised-volatility-only
4. The result survives temporal permutation (arm E collapses)

## Interpretation, fixed in advance

| outcome | reading |
|---|---|
| ML ≈ simple score | *the crash model discovered a simple momentum/regime phenomenon* |
| ML materially beats simple | *nonlinear interactions among momentum features carry extra information* |
| both barely beat realised vol | *the apparent ML edge is mostly volatility-regime detection* |

**Pre-registered expectation:** the third outcome. Section F already showed realised volatility alone
reaches 0.598 against the model's 0.613, and T18 showed the explicit volatility features are
redundant *because the momentum block duplicates them*. If that reading is right, the simple score
should land near both.

---

# RESULTS — run 2026-08-23

| arm | BTC | ETH | SOL | XRP | **mean AUC** |
|---|---|---|---|---|---|
| A ML model | 0.552 | 0.595 | 0.600 | 0.667 | **0.604** |
| **B simple score (mine)** | 0.515 | 0.540 | 0.517 | 0.549 | **0.530** |
| **C realised vol** | 0.597 | 0.601 | 0.550 | 0.646 | **0.598** |
| D 200D trend | 0.515 | 0.485 | 0.480 | 0.364 | 0.461 |
| E shuffled score | 0.501 | 0.500 | 0.499 | 0.500 | 0.500 |

Top-decile precision — ML 31.4 / 47.4 / 63.7 / 61.7 · simple 19.0 / 32.2 / 39.0 / 38.9.

| criterion | result | |
|---|---|---|
| 1. AUC(ML) − AUC(simple) ≥ +0.020 | **+0.0734** | PASS |
| 2. advantage on ≥3/4 assets | 4/4 | PASS |
| 3. simple score beats realised vol | **0.530 vs 0.598** | **FAIL** |
| 4. simple score survives permutation | **0.530 vs 0.500** | **FAIL** |

## Verdict: INCONCLUSIVE — and the reason is my own baseline, not the model

Criteria 1 and 2 pass, and the naive reading is "the ML contains information beyond a simple
momentum index." **That reading is not available**, because criteria 3 and 4 fail: **my score scores
0.530 against a 0.500 random baseline and loses decisively to a one-line volatility rule.**

**A baseline that barely beats coin-flip is not a credible representative of what a simple momentum
rule can do.** The ML beating it is evidence that my score was poorly constructed, not that the model
has special information.

## What I got wrong, specifically

I built the index from **extension** measures — `|z(hRsi−50)|`, `|z(dRsi−50)|`, `|z(dStochK−50)|`,
`z(dAdx)` — on the reasoning that crash risk rises with momentum extension.

But T18's own finding was that the momentum block's predictive content is **largely
volatility-correlated**: ADX is trend strength, MACD-histogram *magnitude* scales with volatility,
and the block's power sits in delta and acceleration terms. **Oscillator levels measure how extended
price is; they do not measure how much it is moving.** I took the wrong projection of the block —
position rather than activity.

A score built from the *magnitudes* of momentum changes (|MACD histogram|, |RSI delta|, |ADX delta|)
would be the faithful test, and is the obvious redo. **I am not running it now**: picking a second
formula after seeing the first fail is exactly the post-hoc iteration this vault forbids. It needs
its own frozen design.

## What T19 does establish

1. **The specific 5-term extension index carries almost no signal** — 0.530 against 0.500 random.
   Momentum *position* does not predict crashes. That is a real, if narrow, negative.
2. **Realised volatility remains the strongest simple rule at 0.598**, versus the ML's 0.604 on these
   folds — **a gap of +0.006**. T18's headline is reinforced, not overturned: the model's
   discrimination barely exceeds a one-line volatility measure.
3. The ML's top-decile precision (31-64%) far exceeds the simple score's (19-39%), consistent with
   the same conclusion.

## Standing interpretation, unchanged from T18

Of the design's three pre-declared readings, the evidence still points to the third:

> **"The apparent ML edge is mostly volatility-regime detection."**

T19 was meant to discriminate between that and the "nonlinear momentum interactions" reading. **It
cannot, because the momentum baseline failed.** The question of whether the momentum block contains
non-volatility information remains genuinely open, and needs an activity-based index to answer.
