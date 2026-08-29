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

---

## MEASURED AT THE USER'S ACTUAL VENUE (2026-08-23, live snapshot)

The 15.2% figure above is **Binance funding, which this user cannot access** (US, 451-geoblocked —
the reason the backend runs behind gluetun). Corrected by measuring Coinbase directly.

**Coinbase does not publish perp funding** — `BIP-20DEC30-CDE` ("nano BTC Perp Futures", 0.01 BTC,
the contract the user trades) returns `funding_rate: ""` from the public API. But Coinbase Derivatives
also lists **dated** nano futures on the same contract size, and those price the carry directly and
better: the basis is LOCKED at trade time instead of floating with funding.

Spot BTC $77,366.46 / ETH $2,446.94:

| contract | price | basis | days | annualized | 24h vol |
|---|---|---|---|---|---|
| BIT-28AUG26-CDE | 77,570.00 | 0.26% | 4.9 | **21.5%** | 23,311 |
| **BIT-25SEP26-CDE** | 78,195.00 | **1.07%** | 32.9 | **12.5%** | 39,139 |
| ET-28AUG26-CDE | 2,451.00 | 0.17% | 4.9 | 13.1% | 30,081 |
| ET-25SEP26-CDE | 2,459.50 | 0.51% | 32.9 | 5.8% | 570 |

### The verdict turns entirely on whether the spot leg must be BOUGHT

Coinbase Advanced spot fees at retail tiers are roughly 0.40% maker / 0.60% taker **per side** —
enormous against a 1.07% basis. Futures legs are ~0.10%.

| | cost | net over 33d | annualized |
|---|---|---|---|
| **buy spot + sell future** (0.40×2 + 0.10×2) | ~1.00% | **+0.07%** | **~0.8% — dead** |
| at taker spot rates (0.60×2) | ~1.40% | **−0.33%** | **negative** |
| **sell future against BTC ALREADY HELD** (0.10×2) | ~0.20% | **+0.87%** | **~10%** |

**So the carry fails in its textbook form and works in its covered form.** Buying spot to run it is
break-even at best — the same fee wall that killed [[strategy-breakeven]]. Selling a dated future
against BTC the user already owns pays roughly **10% annualized** and needs no directional view.

**The cost is upside.** A covered short future caps participation above the future price — in the
62k→80k rally that started this whole investigation, this position would have stopped earning at
78,195. It converts an existing holding into yield; it does not capture moves.

**Caveat: this is one snapshot.** The basis varies with leverage demand — 12.5% today could be 5% or
25% next month. It is observable at any moment from the public API, so it is monitorable rather than
assumable, and the app is well placed to display it.


---

## ⚠️ CORRECTION 2026-08-24 — the fee assumptions were WRONG, and the conclusion changes

The user's actual Coinbase tier is **Advanced 2**, not the generic retail tier I assumed:

| | assumed | **actual** |
|---|---|---|
| spot | 0.40-0.60% per side | **0.125% maker / 0.250% taker** |
| derivatives | ~0.10% per side | **0.065% maker / 0.070% taker** |
| plus | — | **flat $0.12 per contract** (NFA/exchange/clearing) |

The flat per-contract fee is size-dependent and cannot be expressed as one percentage: on a nano BTC
contract (0.01 BTC ≈ $773) it is **0.0155% per side**; on a nano ETH contract (0.1 ETH ≈ $244) it is
**0.049%** — three times heavier for the same $0.12, because the notional is a third the size.

### What this changes

Recomputed against the measured BIT-25SEP26 basis (1.18% over 32.5 days):

| form | round-trip cost | net annualized |
|---|---|---|
| **covered** (futures legs only) | 0.166% | **12.0%** |
| **buy spot (maker) + futures** | 0.416% | **8.9%** |
| buy spot (taker) + futures | 0.666% | 5.9% |

**"Buying the spot leg is dead" was wrong.** At 0.125% maker spot rather than the 0.40-0.60% I
assumed, a bought-spot carry still clears ~9% annualized. The covered form remains better (12.0%),
but the textbook form is viable, which materially widens who can run this.

`GET /basis` default `feePerSide` corrected from 0.001 to **0.0007**. The $0.12/contract fee is NOT
in that percentage — subtract ~0.03% (nano BTC) or ~0.10% (nano ETH) round trip from any net figure
the endpoint reports.
