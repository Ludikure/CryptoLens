# Does the WHALE TRAP flag predict the flush it warns about? — PRE-DECLARED DESIGN

**Status:** design frozen 2026-08-22, BEFORE any result was computed.
**Origin:** the WHALE TRAP flag (F-2, shipped 2026-06-27) has told users for two months that a
liquidation cascade is "stacking up" — and has never been validated, because the ground truth did
not exist. The CandleFeed liquidation archive now supplies it.

> Unlike [[liquidation-features]], this test does not ask whether liquidation data predicts price.
> It asks whether an EXISTING PROMPT FLAG predicts liquidations. A negative result deletes a claim
> the app currently makes to the user, which is worth as much as a positive one.

## The claim being tested

`prompt.ts:1663-1700`. When retail is crowded one side AND ≥2 of four tells fire, the prompt states:

> *"N% of retail is positioned LONG and the conditions for a long flush / liquidation cascade DOWN
> are stacking up … going LONG here means JOINING the crowd that is most exposed to a flush."*

That is a falsifiable forecast: **after a crowded-LONG whale trap, long liquidations should be
elevated relative to baseline.** (And symmetrically for crowded-SHORT → short liquidations.)

## Reconstruction fidelity — stated up front

| tell | source | available? |
|---|---|---|
| retail crowded (≥60% one side) | Binance Vision `metrics/` `count_long_short_ratio` | ✔ |
| top traders leaning against the crowd | Vision `sum_toptrader_long_short_ratio` | ✔ |
| funding stretched in the crowd's direction (>±0.03%) | v14 CSV `fundingRateRaw` | ✔ |
| OI building (>2% / 24h) | Vision `sum_open_interest` | ✔ |
| **spot CVD diverging against the crowd** | not archived anywhere | ✘ |

So this reconstructs **3 of 4 tells**. Production fires on any 2 of 4; this fires on any 2 of the 3
available. **Consequence:** firings where CVD was one of exactly two tells are invisible here, so
this tests a SUBSET of production firings — a subset biased toward the positioning-and-funding
cases rather than the flow cases. A null here does not fully exonerate CVD-driven firings.

## Method

- **Universe:** BTC, ETH, SOL — the symbols with both Vision metrics history and CandleFeed
  liquidation history. Daily resolution throughout (liquidation aggregates are daily).
- **Flag:** evaluated on day D from that day's LAST metrics observation, so it uses only
  information available by the close of D.
- **Outcome:** day **D+1** long-liquidation share = `long_liq_usd / (long_liq_usd + short_liq_usd)`.
  Strictly forward, no same-day overlap with the flag's inputs.
- **Baseline:** the same statistic over all days for that symbol.
- Reported per crowd side, and per symbol, with the pooled figure.

## Ship bar — declared now

The flag is VALIDATED if, pooled across the three symbols:

1. After crowded-LONG firings, next-day **long-liquidation share ≥ baseline + 5pp**, AND
2. After crowded-SHORT firings, next-day **long-liquidation share ≤ baseline − 5pp**
   (i.e. shorts get liquidated instead — the flag's own symmetric claim), AND
3. Each side has **n ≥ 30** firing days, otherwise that side is reported as underpowered rather
   than as evidence.

If the effect is present but under 5pp, it is recorded as "directionally right, too weak to act on."
If it is absent or inverted, the flag is making a claim it cannot support and the prompt text should
be softened to a positioning description without the cascade forecast.

**Pre-registered expectation:** genuinely uncertain — this is the least-prejudged test in the vault.
The mechanism is sound (crowded leverage IS what gets liquidated) and it is nearly tautological that
a crowded-long market liquidates longs when price falls. The open question is whether the flag adds
anything beyond "retail is long", which is the control below.

## Control — the one that decides whether the flag EARNS its complexity

Also measured: next-day long-liquidation share conditioned on **crowding alone** (retail ≥60% long,
no tells required). If the full flag does not beat crowding-alone, the four tells are decoration and
the flag should be simplified to the crowding line it already prints two rows above.

## Known limitations

- 3 symbols, daily resolution; production fires on 4H bars.
- Liquidation magnitudes inherit Binance's 1-event/sec/symbol sampling cap (lower bounds, but the
  SHARE metric used here is a ratio, so the cap largely divides out).
- CVD tell missing (see fidelity table).

---

## RESULTS

## RESULTS

Run 2026-08-22 (`ml-training/whale_trap_validation.py`). BTC/ETH/SOL, **5,357 overlapping days**
(BTC 2020-09-01→, ETH & SOL 2021-12-01→). Baseline next-day long-liquidation share **52.9%**.

### Verdict: NOT VALIDATED — by 0.2pp. But the finding is useful, and it is not "the flag is junk".

| condition | next-day long-liq share | vs baseline | n |
|---|---|---|---|
| **WHALE TRAP, crowded LONG** | 57.7% | **+4.8pp** | 132 |
| **WHALE TRAP, crowded SHORT** | 34.9% | **−18.0pp** | 33 |
| control: crowding alone, LONG | 54.9% | +2.0pp | 3,632 |
| control: crowding alone, SHORT | 43.3% | −9.6pp | 96 |

| pre-declared criterion | result | |
|---|---|---|
| crowded-LONG → ≥ base+5pp | **+4.8pp** | **FAIL** (by 0.2pp) |
| crowded-SHORT → ≤ base−5pp | −18.0pp | PASS |
| n ≥ 30 per side | 132 / 33 | PASS |

**The bar was not moved.** +4.8 is not +5.0. The design anticipated this exact outcome and named it
in advance: *"directionally right, too weak to act on."* That is the honest label for the LONG side.

### The three things worth acting on

**1. The tells EARN their complexity.** The control question was whether the four-tell machinery beats
the "N% of retail is long" line the prompt already prints two rows above. It does: **+2.8pp** better on
the LONG side (57.7 vs 54.9) and **8.4pp** better on the SHORT side (34.9 vs 43.3). The flag is not
decoration — do NOT simplify it away.

**2. The LONG-side warning is weak because it is nearly the BASE CASE.** Long liquidations are 52.9%
of the total on an average day — crypto simply carries more leveraged longs. So warning a user about
"a long flush" is only ~5pp more informative than saying nothing, on top of a state that is already
the default. The prompt's language ("the conditions for a long flush / liquidation cascade DOWN are
stacking up") implies far more than +4.8pp of tilt.

**3. The SHORT-side warning is genuinely strong and is currently UNDERSOLD.** A crowded-short whale
trap moves the long-share from 52.9% to 34.9% — an 18pp swing, meaning shorts really do become the
liquidated side. That is 3.6× the pre-declared bar and it survives the control comparison. n=33 is
thin (just over the power floor) so treat the magnitude as provisional, but the direction is not in
doubt.

### Recommended product change

Differentiate the two sides in `prompt.ts:1697`, rather than printing symmetric language:

- **crowded SHORT → keep the strong warning.** The squeeze-up claim is supported.
- **crowded LONG → soften.** State the positioning honestly ("you would be joining the crowded side")
  and drop the implication that a cascade is imminent. Measured tilt is ~5pp over a base rate that is
  already 53% — real, but not the drama the current wording carries.

This is a case where a failed test improves the app rather than deleting a feature.

### Limitations (unchanged from the design)

3 symbols, daily resolution against a flag that fires on 4H bars, CVD tell absent so this covers a
subset of production firings, and n=33 on the side with the strongest effect.
