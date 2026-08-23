# Cash-and-carry funding harvest — EXPLORATORY MEASUREMENT

**Status:** exploratory, 2026-08-23. **This is a measurement, not a validated strategy.** No ship
bar was pre-declared because nothing is being decided yet — it characterises an opportunity the
project has never examined. Acting on it requires its own frozen design with full costs.

## Why it was never tested, and why that was an oversight

Every strategy in this vault takes a DIRECTION at a SHORT horizon with HIGH turnover. Direction is a
coin flip ([[rejected-hypotheses]]) and fees consume the rest, so they fail for the same two reasons
each time. The cash-and-carry does neither: long spot + short perp is delta-neutral, so **the coin
flip is irrelevant by construction**, and it is held for months, so turnover is near zero. The app
has computed `basisPct` and `fundingRateRaw` since v11 without anyone asking what they were worth
standing alone.

## Measured (12 symbols, 2020-08 → 2026-06, funding only)

| | |
|---|---|
| CAGR | **15.2%** |
| max drawdown | **−3.04%** |
| Sharpe | **6.00** |
| median per-symbol annualised funding | 15.7% |
| days with negative funding | 17% |

Per calendar year: 2020 +8.0, 2021 **+46.3**, 2022 **−2.1**, 2023 +6.3, 2024 +12.5, 2025 +3.3,
2026 +20.6.

Wide per-symbol dispersion: LINK 19.0% and ETH 18.2% at the top; SOL 1.1%, DOT 2.6%, BNB 5.7% at the
bottom. Symbol selection matters more than the headline suggests.

## Why the Sharpe of 6 is overstated — the risks funding EXISTS to pay for

Funding is not free money; it is the price paid to whoever absorbs these:

1. **Venue risk — the dominant one.** The trade requires holding spot AND a perp position at an
   exchange. FTX is the reference case: the funding series shows nothing, and the position went to
   zero. A time series of funding rates cannot express this and my Sharpe therefore excludes the
   single largest risk in the trade.
2. **Liquidation of the short leg.** If price rallies hard, the perp short loses while the spot gains
   — economically flat, but only if the two are cross-margined. Split across venues, the perp can be
   liquidated while the spot sits safe, converting a neutral position into a realised loss at the
   worst moment.
3. **Basis convergence.** This measures funding only. The actual entry pays a spot-perp spread and
   the exit unwinds it. Small over long holds, not zero.
4. **Capital efficiency.** Both legs need funding. Return on TOTAL deployed capital is below the
   notional-based 15.2% — how far below depends entirely on margin treatment.
5. **It is a crowded, well-known trade.** Its persistence is evidence that the risks above are real
   and priced, not that the market has missed something.

## What it does and does not answer

**It does not answer the question that prompted today's work.** The carry earns LEAST in bear
markets — 2022 was its only negative year (−2.1%) — because funding compresses when longs stop
paying up. It is not a way to profit from a decline.

**It answers a different and arguably more useful question:** what do you do with capital when
direction is unknowable? Every other candidate here is break-even at best after fees. This one is
structurally positive, price-neutral, and pays best in exactly the bull conditions where the
directional strategies are most tempting and most dangerous.

## Before acting, a frozen design must add

Realistic two-leg execution costs, margin and capital treatment, basis at entry/exit, an explicit
venue-risk position (position limits per exchange), and a funding-negative regime rule. Until then
this is a promising measurement, nothing more.
