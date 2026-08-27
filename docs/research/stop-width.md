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
