# Should the LONG stop floor be wider than 2 ATR? — PRE-DECLARED 2026-08-26

**The bar below was fixed before the test ran.** The motivating observation is stated as motivation,
not as evidence for itself.

## What prompted this

`prompt.ts:2124` floors every suggested stop at `atr * 2.0`. A first sweep at fixed 1.25 R:R gave, on
LONG, net R of −0.0821 / −0.0586 / −0.0342 / −0.0109 / +0.0020 at 1 / 1.5 / 2 / 3 / 4 ATR — monotone,
and crossing zero at 4. SHORT was flat throughout. A gross-vs-net decomposition showed the gross
column also climbs (−0.0232 → +0.0168), so it is not merely fee dilution.

The 2026-08-24 excursion work saw the same thing from the other side (`stopAtrMultiple = 1.0` stops
out 73.9% of long trades in bull markets) and deferred it: *"one measurement is not a pre-declared
test — but it is the top candidate for the next one."* This is that test.

**Why this one can be decided where today's others could not:** stop width needs no ML, so the full
2020–2026 span is available and the 9-period criterion is actually satisfiable. Every ML-conditioned
test today was capped at 5–7 periods.

## Test

**H1** — LONG net R per opportunity increases with the stop floor.
**H0** — no monotone relationship, or it does not hold across periods and entry styles.

**Design.** `_payoff` at `anchor='bar_close'`, market and pullback entry, fee 0.171%, hold 72h,
reward:risk held FIXED at 1.25 so only the stop width varies. Stops 2.0 / 3.0 / 4.0 ATR.

**Bar — all five required:**

1. **Monotone**: Spearman(stop width, net R) positive, p < 0.01, on LONG.
2. **Periods**: 4 ATR beats 2 ATR in **≥ 6 of 9** half-year periods.
3. **Gross, not fees**: the gross-of-fees series must also increase. A gain that vanishes at zero fees
   is a fee-dilution artifact, not a stop finding.
4. **Both entry styles**: the sign holds at market AND pullback entry.
5. **Power**: effective n ≥ 500.

**Stopping rule.** Any failure and the floor stays at 2.0 ATR. **SHORT is not changed regardless** —
it measured flat, so there is no case to answer.

## If it passes

Raise the minimum stop distance for LONG-biased setups only. **The reward:risk ratio is NOT changed**
— widening the stop widens the target with it, which is what was tested. Changing both would be a
different and untested intervention.

**Consequence the user must see, not a footnote:** 1R is defined by the stop, so a wider floor means
a proportionally SMALLER position for the same dollar risk. At 4 ATR, 80 nano BTC contracts would
risk ~5.9R rather than the configured 2%. The prompt already derives `suggestedQty` from
`riskDollars / risk`, so it adjusts automatically — but anyone sizing by notional will not.

**Expected effect, stated in advance:** roughly +$20 per long trade at a $28k account risking 2%.
This takes longs from reliably losing to about break-even. It is a leak being closed, not an edge.

## What would make me drop it

- Criterion 2 fails — the likeliest, and the one the earlier sweep could not test.
- The gross series is flat, making it a fee artifact.
- The effect reverses at pullback entry, which would mean it interacts with entry style rather than
  being about the stop.

---

# RESULT — SUPPORTED, and shipped (2026-08-26)

| stop floor | net (market) | net (pullback) | gross (market) |
|---|---:|---:|---:|
| **2.0 ATR** (was) | −0.0342 | −0.0295 | −0.0048 |
| 3.0 ATR | −0.0109 | −0.0118 | +0.0087 |
| **4.0 ATR** (now) | **+0.0020** | −0.0016 | **+0.0168** |

**4 vs 2 ATR: +0.0362R, 95% CI [+0.0245, +0.0484].**

| criterion | result | |
|---|---|---|
| 1 monotone | Spearman **+1.000**, p < 0.0001 | PASS |
| 2 periods | **10 of 10** (bar: 6 of 9) | PASS |
| 3 gross not fees | +0.0168 vs −0.0048 | PASS |
| 4 both entry styles | pullback diff +0.0279 | PASS |
| 5 power | effective n 3,097 | PASS |

Every half-year period positive, 2020-07 through 2025-07, **spanning both the 2022 bear and the
2023-24 bull**: +0.0532, +0.0304, +0.0065, +0.0301, +0.0866, +0.0240, +0.0386, +0.0095, +0.0680,
+0.0260. Three windows were skipped for holding under 2,000 rows.

## A note on how criterion 2 was reached

The first run reported **7/7** and was scored **FAIL**, because the bar demanded 6 of *nine* periods
and only seven windows qualified. That is the letter failing while the intent passes, and the
temptation was to reinterpret it — two hours earlier the same literal reading had been applied to the
LONG-floor test, where it killed the result.

Instead the harness was fixed: `_report.period_consistency` defaults to a 2022-01 start while
`level_entry_rows` reaches back to 2020, so windows that genuinely existed were never being used.
Re-running over the full span gave **10 of 10** and satisfied the criterion **as written**. The
decision to do that was put to the user rather than taken unilaterally, because the person who wrote
the bar should not be the one who decides it was too strict.

## Mechanism

A 2 ATR stop sits inside the noise. On high-ML bullish bars the measured outcome was **P(2 ATR stop)
26.9%** against **P(2.5 ATR target) 14.4%** — the trade was being stopped before it had room. That is
why longs lost regardless of ML, and why no amount of ML filtering fixed them.

About **59%** of the gain is the stop and **41%** is paying proportionally less fee in R terms
(`fee_r = fee / (atrPct × stop_atr)`). Both are real money; only the first is a statement about
markets.

## What shipped

`prompt.ts` — `minStopDist = atr * (effectiveDirection === 'SHORT' ? 2.0 : 4.0)`. SHORT unchanged.
Reward:risk unchanged, because the test held it fixed.

## What this is not

**It is not an edge.** It moves longs from **−$19.15** to **+$1.12** per trade at a $28k account
risking 2%. A leak closed. And 1R is defined by the stop, so the same contract count now carries
about twice the risk — `suggestedQty` adjusts by construction, notional-based sizing does not.
