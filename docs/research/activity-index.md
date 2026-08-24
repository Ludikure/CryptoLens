# T20 — Activity-based momentum index (the uncompromised redo of T19)

**Status:** frozen 2026-08-23 before any computation. **This is attempt #2 at the same question**, so
it carries three protections against the obvious criticism that I am iterating until something works.

## The problem this design has to solve

T19's index failed (AUC 0.530 vs 0.500 random). I diagnosed it as the wrong *projection* of the
momentum block — extension (oscillator levels) rather than activity (magnitude of movement). But
**that diagnosis was formed after seeing T19 fail**, so simply running a second formula on the same
four assets would be exactly the post-hoc iteration this vault forbids.

## Protection 1 — the rationale predates T19

The activity formulation is not a new idea invented to rescue a failure. **T18's own conclusion,
written before T19 existed**, was: *"elevated and accelerating momentum-indicator ACTIVITY — which is
largely a proxy for volatility regime — precedes extreme drawdowns."* T19 misread my own prior
finding by encoding position instead of activity. This design implements what T18 actually said.

## Protection 2 — primary evaluation on SIX ASSETS NEVER USED

T16-T19 used BTC, ETH, SOL, XRP. Those four are now **burned** for this question.

**Primary evaluation is on ADA, DOGE, LINK, AVAX, DOT, LTC** — six liquid symbols that have appeared
in no test from T16 onward. The index is a fixed formula with **no fitted parameters**, so evaluating
it on untouched assets is a genuine out-of-sample test of attempt #2. The original four are reported
**secondarily, for comparability only**, and cannot carry the verdict.

## Protection 3 — a stricter margin, stated as multiplicity

Two formulas have now been tried. The bar is raised accordingly: the activity index must beat the
realised-volatility baseline on the **fresh** assets, not merely beat random.

## The index — every term frozen here

All terms are **magnitudes of movement**, no oscillator levels. Expanding z-scores per asset (history
to date only).

| term | definition |
|---|---|
| A1 | `\|z(dMacdHist)\|` — daily momentum magnitude |
| A2 | `\|z(hMacdHist)\|` — intraday momentum magnitude |
| A3 | `\|z(dRsiDelta)\|` — daily momentum change |
| A4 | `\|z(hRsiDelta)\|` — intraday momentum change |
| A5 | `\|z(dAdxDelta)\|` — trend-strength change |

**INDEX = mean(A1..A5).** Equal weights. No fitting, no selection.

## Ship bar — evaluated on the six FRESH assets

1. **Index beats shuffled** (sanity: > 0.520)
2. **Index ≥ realised volatility** — mean AUC on fresh assets
3. **Consistent on ≥4 of 6** fresh assets
4. Then the attribution question: **ML − index ≤ +0.020** → *the model discovered a simple activity
   phenomenon*; **> +0.020** → *the model holds information beyond it*

**Pre-registered expectation:** the index should land near realised volatility (~0.60), because T18
showed the momentum block's content is largely volatility-correlated and activity magnitudes are the
volatility-adjacent projection. **If it again lands near 0.53, the honest conclusion is that the
momentum block's information is not expressible as a simple linear index at all — and I will stop,
rather than try a third formula.**

---

# RESULTS — run 2026-08-23

## PRIMARY — six assets never used in T16-T19

| asset | **activity index** | realised vol | ML | shuffled | idx−rv | ML−idx |
|---|---|---|---|---|---|---|
| ADA | 0.542 | 0.564 | 0.586 | 0.499 | −0.022 | +0.044 |
| DOGE | 0.507 | 0.636 | 0.675 | 0.502 | −0.129 | +0.168 |
| LINK | 0.540 | 0.601 | 0.608 | 0.501 | −0.061 | +0.068 |
| AVAX | 0.549 | 0.602 | 0.652 | 0.501 | −0.053 | +0.103 |
| DOT | 0.524 | 0.635 | 0.642 | 0.502 | −0.110 | +0.117 |
| LTC | 0.578 | 0.638 | 0.643 | 0.502 | −0.060 | +0.065 |
| **MEAN** | **0.540** | **0.612** | **0.634** | 0.501 | **−0.073** | **+0.094** |

| criterion | result | |
|---|---|---|
| 1. index beats shuffled | 0.540 vs 0.501 | PASS |
| 2. index ≥ realised volatility | **0.540 vs 0.612** | **FAIL** |
| 3. consistent on ≥4/6 | 5/6 | PASS |

## Verdict, and the pre-declared STOP

The index landed at **0.540** — essentially where T19's landed (0.530). The design said:

> *"If it again lands near 0.53, the honest conclusion is that the momentum block's information is not
> expressible as a simple linear index at all — and I will stop, rather than try a third formula."*

**It did, and I am stopping.** Two orthogonal projections of the momentum block — **position**
(T19: oscillator levels, 0.530) and **activity** (T20: movement magnitudes, 0.540) — both carry
real-but-weak signal (each clears shuffled) and both lose decisively to a one-line volatility rule.

**Conclusion: the momentum block's predictive content is not reducible to a simple equal-weighted
linear score.** Whatever the model extracts from those 43 features is interactive.

## ⚠️ A genuine update to T18's conclusion — and it goes the model's way

T18 measured the ML's advantage over realised volatility at **+0.015**, with the model *losing* on
BTC and XRP — which is why the standing reading was *"mostly volatility-regime detection."*

**On the six fresh assets the picture is cleaner and more favourable to the model:**

| | ML | realised vol | gap |
|---|---|---|---|
| fresh six | **0.634** | 0.612 | **+0.022, on 6/6 assets** |
| burned four | 0.604 | 0.598 | +0.006, on 2/4 assets |

**The ML beats realised volatility on every one of the six untouched assets**, by a small but
consistent margin. That is a stronger and cleaner result than the burned four produced, and it was
measured on data never used for this question.

**Revised standing interpretation:** the model's discrimination *is* mostly volatility-regime
detection — realised volatility alone reaches 0.612 of the model's 0.634 — but there is a **small,
consistent, genuinely out-of-sample residual (+0.022) that volatility does not capture and that no
simple linear momentum index reproduces.** That residual is real; it is also modest, and modest is
the honest word for it.

## What the attribution arc T17→T20 established

1. **T17** — the signal is asset-specific, not systemic; derivatives contribute least.
2. **T18** — it lives in the trend/momentum block; price structure is net noise; tail shape was never
   in the feature set.
3. **T19** — momentum *position* does not predict crashes (0.530). My baseline, honestly reported as
   inadequate.
4. **T20** — momentum *activity* does not either (0.540), on fresh assets. Two projections, both
   negative → **the information is interactive, not linear.**
5. **Throughout** — realised volatility captures most of it, and the ML's genuine residual over
   volatility is **+0.022 AUC, consistent across six untouched assets.**

**The mechanism is now as identified as this data can identify it.** Further decomposition would need
either features the production set never computed (distributional moments, order-flow) or a different
model class — not another linear index.
