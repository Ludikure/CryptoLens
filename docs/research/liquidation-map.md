# Where does forced flow actually concentrate? — EXPLORATORY

**Status:** exploratory characterisation, 2026-08-22. No ship bar — this measures a structural
fact rather than deciding a hypothesis. Any PREDICTIVE claim built on it needs its own
pre-declared test.

## Why this is different from a commercial "liquidation heatmap"

Coinglass and peers *assume* a leverage distribution, *assume* entry prices from OI changes, and
derive clusters from those assumptions. Nothing is validated, because the builders have no ground
truth for where liquidations actually happened. The CandleFeed archive supplies per-event prices,
so this runs the other way: observe where cascades landed, and learn the relationship.

## Metric: intensity, not share

    intensity(zone) = share of liquidation notional in zone / share of TIME price spent in zone

Time-normalisation is the entire point. Longs die when price falls, so "long liquidations happen at
low prices" is true by construction and shows up as a huge raw share. Dividing by occupancy removes
that tautology. **1.0x means a zone sees exactly the forced flow its time-at-price predicts.**

Anchors are computed from CLOSED history (`shift(1)`), so a level never sees the bar it is tested
against. Liquidations join to the prevailing hourly level via `merge_asof(direction='backward')`.

## Result — replicated across 3 symbols and both sides

Data: CandleFeed per-event liquidations (2026-05-28 → 2026-08-21) + Binance Vision 1h klines.

| symbol | side | % of time beyond prior-7d extreme | % of liq notional | **intensity** | VWAP control |
|---|---|---|---|---|---|
| BTC | LONG | 1.4% | 48.5% | **33.99x** | 1.91x |
| BTC | SHORT | 1.4% | 41.2% | **30.06x** | 1.62x |
| ETH | LONG | 1.1% | 35.4% | **33.63x** | 1.89x |
| ETH | SHORT | 1.1% | 44.2% | **40.17x** | 1.67x |
| SOL | LONG | 1.2% | 43.8% | **35.15x** | 1.93x |
| SOL | SHORT | 1.5% | 46.0% | **30.03x** | 1.71x |

**Price spends ~1.2% of its time beyond the prior 7-day extreme, and roughly 40% of all forced
liquidation notional prints there.**

The 24h-VWAP control is what makes this credible: pinned at 1.6-1.9x in all six cells, it shows the
metric CAN return "nothing structural". The 30-40x is not an artifact of the construction.

### Anchor comparison (BTC, LONG side) — precision/recall, as expected

| anchor | % time | % liq | intensity |
|---|---|---|---|
| prior 7d low | 1.4% | 48.5% | **33.99x** |
| prior 3d low | 2.4% | 54.7% | 22.97x |
| prior 24h low | 4.5% | 69.5% | 15.32x |
| −1 ATR | 5.7% | 79.0% | 13.87x |
| **round $1000** | 8.8% | 72.5% | **8.23x** |
| 24h VWAP | 47.9% | 91.7% | 1.91x |

Longer lookback → higher intensity, lower coverage. Round numbers at 8.2x are a genuine finding in
their own right: psychological stop placement is visible in the forced-flow data.

## What this DOES and DOES NOT establish

- **DOES:** conditional on price reaching a multi-day extreme, forced-flow density beyond it is
  ~30-40x its time-weighted baseline. A stop placed just past a 7-day extreme sits in the densest
  liquidation zone on the chart. A break of that extreme has cascade fuel behind it.
- **DOES NOT:** show that price is more LIKELY to travel there. The "liquidity magnet" claim —
  that clusters attract price — is a far stronger hypothesis and is **not tested here**. Do not let
  the app imply it.

That distinction is the whole reason this is filed as exploratory. The conditional statement is
directly useful for STOP PLACEMENT, which is a risk decision. The unconditional one would be a
direction claim, and direction is a coin flip in this project.

## Generalisation check — all 32 symbols with tick data

The first pass measured 3 majors and the prompt line was written from them, which asserted a
majors number at every crypto symbol. Extended to the full tick set (2026-05-28 → 2026-08-21):

| group | LONG 7d (median) | SHORT 7d (median) | VWAP control |
|---|---|---|---|
| **Majors** (n=12) | **34.6x** | 30.5x | 1.9x |
| **Alts** (n=20) | **30.2x** | 26.0x | 1.7x |

**The effect is universal, not a majors artifact.** Every one of the 32 symbols exceeds 13x, and
the VWAP control stays pinned at 1.1-2.2x in every cell. Range: TRX 66.0x (long) at the top,
AAVE 13.1x (short) at the bottom.

**Alts run slightly LOWER than majors** (30.2 vs 34.6 median) — the opposite of the "thin books
cascade harder" intuition, and the reason this check was worth running rather than assuming.

Prompt wording was corrected from "~30-40x" (the majors figure) to "~20-45x, median ~30x" so the
app quotes a number that holds across the universe it actually applies to.

## Limitations

- ~3 months (the tick archive begins 2026-05-28), 3 symbols.
- Magnitudes inherit Binance's 1-event/sec/symbol sampling cap; intensity is a ratio so the cap
  largely divides out, but absolute notional is a lower bound.
- Hourly resolution for time-at-price.

## Next, if pursued

1. Annotate cascade-prone levels in the prompt (**done 2026-08-22**, see below).
2. A pre-declared test of whether stops just beyond multi-day extremes are swept more often than
   `risk-engine.stopQuality()`'s HAR-RV model predicts — that would be an actual improvement to
   position sizing rather than a narrative one.
3. Only then, if ever, the magnet hypothesis — with a real ship bar.
