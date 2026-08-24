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
