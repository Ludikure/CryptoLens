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

---

# RESULTS — run 2026-08-24

| asset | A FULL (120) | B (94) | C (68) | **D MINIMAL (55)** |
|---|---|---|---|---|
| BTC | **0.611** | 0.552 | 0.558 | 0.565 |
| ETH | 0.601 | 0.595 | 0.600 | 0.596 |
| SOL | 0.584 | 0.600 | 0.605 | **0.607** |
| XRP | 0.640 | 0.667 | **0.667** | 0.663 |
| ADA | **0.603** | 0.586 | 0.590 | 0.589 |
| DOGE | 0.639 | 0.675 | **0.676** | 0.674 |
| LINK | 0.595 | 0.608 | 0.615 | **0.614** |
| AVAX | 0.607 | **0.652** | 0.650 | 0.651 |
| DOT | 0.629 | 0.642 | 0.652 | **0.652** |
| LTC | 0.645 | 0.643 | 0.646 | **0.648** |
| **MEAN** | **0.6154** | 0.6220 | 0.6259 | **0.6260** |
| **vs FULL** | — | +0.0067 | +0.0105 | **+0.0106** |

**All three reduced arms PASS**, and none of them merely matches the full set — every one **beats**
it. Applying the pre-declared smallest-wins rule:

> **D MINIMAL — 55 features, down from 120. 54% removed, and AUC improves by +0.0106.**

For scale: the entire measured advantage of the ML model over a one-line realised-volatility rule is
+0.022 (T20). Removing 65 features recovers about half that much again.

## Why removing features improves the model

Textbook, and the numbers show it plainly: with 120 columns and depth-4 trees, every additional noise
feature is another chance to split on a spurious pattern. C (68) and D (55) score identically
(0.6259 vs 0.6260), so the final 13 — tail shape, liquidity, cross-horizon — contribute exactly
nothing, matching T18's isolated measurements of −0.0005, −0.0001 and −0.0018.

**The interaction risk I flagged did not materialise.** Removing 65 features at once behaves the same
as removing the blocks one at a time.

## ⚠️ Two caveats that bound what this licenses

**1. This tested the CRASH target, not the production one.** T22 trains on
`y_crash = P(10% drawdown in 10 days)`. The shipped model is trained on
`goodR = fwdMaxFavR >= 1.5 within 24h` — a different target. Feature redundancy is largely a property
of the features rather than the target, so this very likely transfers, but **"very likely" is not
"measured."** Acting on the production model requires re-running this against `goodR` first.

**2. BTC is the one real loss, and it is not small.** A 0.611 → D 0.565, a drop of **0.046** — while
seven of ten assets improve. BTC has the deepest derivatives coverage, the longest history and the
most liquidity, so the extra features may genuinely help there. Either that or it is noise. **Do not
prune without checking BTC specifically**, since it is the symbol the user actually trades.

## What this does and does not remove from the app

Removing a feature from the MODEL is not removing it from the product. Several pruned inputs also
feed the prompt and the UI, and must stay:

| block | drop from model | still needed for |
|---|---|---|
| derivatives | yes | the D1 archive, the DERIVATIVES POSITIONING prompt section, the whale-trap flag |
| market-wide | yes | MACRO_CONTEXT in the prompt, the macro card |
| price structure | yes | TAGGED LEVELS, VWAP/POC display, `LevelsChartView` |

**The saving is in model complexity and retraining surface, not in upstream fetches** — the cron still
needs most of these for the analysis prompt. The honest benefit is a model with half the inputs,
less overfitting surface, and a much smaller parity contract between worker and iOS.

## Verdict

**Justified as research; not yet actionable on production.** The next step is the same test against
`goodR`, with BTC reported separately. If it holds, a v15 retrain on ~55 features is warranted — and
that is a real piece of work: new model JSONs, worker↔iOS 1e-7 parity re-verification, fixture
refresh, deploy.
