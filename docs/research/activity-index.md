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
