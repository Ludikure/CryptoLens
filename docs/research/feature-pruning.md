# T22 — Which features can be removed?

**Status:** frozen 2026-08-24 before computation. **Simplification test, not a search.**

## Why this is worth doing even though it won't improve returns

T21 closed feature *addition*. This tests the opposite direction, and it has a measured mandate:
T18 found that removing 26 price-structure features **improved** AUC, top-decile precision and
Brier simultaneously. A smaller model with equal performance is strictly better — less drift risk,
less to retrain, less to break, faster inference, fewer upstream dependencies to keep alive.

## The discipline problem, and how this design avoids it

Testing many subsets and shipping the best is overfitting. **So no subset is searched here.** Every
removal candidate is derived from evidence already recorded in prior tests, and the arms are a fixed
progressive sequence declared below.

| block | size | prior evidence | verdict |
|---|---|---|---|
| TREND/MOMENTUM | ~43 | T18: **−0.0501** when removed, ~8× any other | **KEEP** |
| REALISED VOL | 8 | T18: −0.0063 | **KEEP** (marginal but negative) |
| MARKET-WIDE | 13 | T17: arm E (no market-wide) **≥** arm A | remove |
| DERIVATIVES | 13 | T17 weakest block (0.549); 2026-07-05 audit found **zero splits** | remove |
| PRICE STRUCTURE | 26 | T18: **+0.0038 when removed** — net noise | remove |
| TAIL SHAPE | 3 | T18: −0.0005 | remove |
| LIQUIDITY | 7 | T18: −0.0001 | remove |
| CROSS-HORIZON | 3 | T18: −0.0018 | remove |

## Arms — a fixed progressive sequence, all reported

- **A FULL** — all production features (the current model)
- **B −market-wide, −derivatives** — T17's territory
- **C = B −price structure** — adds T18's strongest removal
- **D MINIMAL = trend/momentum + realised volatility only** — everything the prior evidence says is
  load-bearing, and nothing else

## Ship bar

A reduced set is shippable only if:

1. Its mean AUC is **within 0.005 of FULL** (across all ten assets)
2. It is within that margin on **≥7 of 10** assets
3. It holds on the **six fresh assets** specifically, not just the burned four

**Among arms meeting the bar, the SMALLEST is preferred** — that rule is fixed now, so the choice
cannot be made by looking at which scored highest. Size is the objective; AUC is the constraint.

## What this test does NOT do

It does not ship anything. These features feed the live production model, so acting means a retrain,
new model JSONs, worker↔iOS parity re-verification and a deploy. **This establishes whether that work
is justified.** The change itself is a separate exercise with its own risks.

**Pre-registered expectation:** arm C or D clears the bar. T18's evidence is fairly direct, and the
2026-07-05 audit independently found derivatives contributing zero splits. The genuine uncertainty is
whether removing ~65 features at once behaves like removing them one at a time — interactions could
mean the whole is worse than the parts suggest.
