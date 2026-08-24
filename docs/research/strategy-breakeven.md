# strategy-breakeven


---

## ⚠️ CORRECTION 2026-08-24 — at the user's REAL fee tier the convex strategy is +EV

This note recorded **+0.151R gross, break-even 0.238% round trip, and −0.008R at "Coinbase Intro-1
(~0.25%)"**. That fee figure was wrong. The user's actual tier is **Advanced 2**: derivatives
**0.065% maker / 0.070% taker**, plus a flat **$0.12 per contract**.

Round trip on nano BTC (0.01 BTC ≈ $773 notional, so $0.12 = 0.0155% per side):

| execution | round trip | net EV |
|---|---|---|
| maker both sides | 0.161% | **+0.049R** |
| taker both sides | 0.171% | **+0.042R** |
| *(previously assumed)* | *0.250%* | *−0.008R* |

**The strategy clears its own break-even by a comfortable margin — and beats the +0.024R the vault
attributed to Binance's assumed ~0.10%/side.** The user's real venue is cheaper than the offshore
reference this project spent months treating as the unreachable ideal.

### What has NOT changed, and it is the binding constraint

The **11.8% win rate** at 5R:1R. Roughly 88% of trades lose 1R, so the edge exists only if traded
**mechanically and completely** — any discretionary skipping destroys it. That was true at −0.008R
and is true at +0.042R.

Also unchanged: the [[t9-attribution-audit]] / [[entry-filter]] findings about turnover, and the fact
that +0.042R per trade is a thin edge requiring many trades to express. **This correction makes the
strategy viable, not easy.**

**Nano ETH is materially worse** — the same $0.12 against a $244 notional is 0.098% round trip versus
BTC's 0.031%, pushing the total to ~0.238% and landing exactly on break-even. Size the contract to
the fee.
