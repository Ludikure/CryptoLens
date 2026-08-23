# The `biases_MIXED` ML gate — pre-declared test (OPEN, not yet run)

**Status:** hypothesis with a pre-declared decision rule. **Nothing shipped.** Written 2026-07-24
after a live complaint ("BTC ran to 67k and the app was auto-FLAT all week") was traced to this
gate. Read [[strategy-counter-trend]] and [[rejected-hypotheses]] before touching it.

Related: [[edge-methodology]] (fold/purge/weighting conventions), [[ml-model-versions]] (the v14
calibration table this argument leans on).

## The rule under test

`prompt.ts` Conviction Envelope:

```ts
if (envAlignment === 'MIXED' && (mlPct == null || mlPct < 70)) autoFlat.push(`biases_MIXED_and_ML_${mlPct}<70`)
```

Shipped 2026-07-06 to make the counter-trend playbook reachable: `mixed_flat_test.py` (clean v14
regen, 870K crypto + 503K stock bars) found non-aligned bars carry **~2× the goodR rate** of
aligned bars — crypto 61/59% vs 33/30%, stocks 70/71% vs 39/35% — so the previously-unconditional
MIXED auto-FLAT was suppressing the system's best volatility cell. The fix ML-gated it at 70.

## Why the gate looks wrong on its own terms

Three facts that sit badly together:

1. **The gate is set above the base rate of the cell it exists to unlock.** The non-aligned cell
   realizes ~61% goodR (crypto daily). The gate demands ≥70 — about 9pp *above* the cell's own
   average — before permitting a setup.
2. **ML ≥ 70 is rare.** Per the v14 crypto calibration table, the 70-85 bucket holds 9,136 of
   145,045 bars = **6.3%**. So on non-aligned bars (60-66% of all bars) the FLAT still fires
   roughly 94% of the time. The 2026-07-06 change unlocked the cell in principle and left it
   locked in practice.
3. **`ML_WIN < 50` is already its own separate auto-FLAT.** So the MIXED rule's *only* marginal
   effect is blocking the **50-70 band** — which the v14 table says realizes **55.9%** (50-60) and
   **64.1%** (60-70), i.e. at or above the non-aligned base rate. It blocks the better half of the
   better cell.

### Live evidence that prompted this (BTCUSDT, 2026-07-13 → 07-24)

Replayed the real `buildUserPrompt` over 73 real 4H bars (Kraken XBTUSDT; Binance is geoblocked
off-box, closes matched the box's Binance feed to within 0.03% across all 90 overlapping bars).
ML_WIN stubbed at a fixed level per run to isolate the envelope from the model:

| ML_WIN stub | bars auto-FLAT | dominant reason |
|---|---|---|
| < 70% | **70 / 73 (96%)** | `biases_MIXED_and_ML_<70` on 63 bars |
| ≥ 70% | **7 / 73 (10%)** | chase guard only |

Daily bias never turned Bullish through the entire +7.5% advance (Bearish → Neutral while 4H read
Strong Bullish), so alignment read MIXED essentially the whole way up. Environment Risk was
ELEVATED on all 73 bars.

**The honest counterweight, and the reason this is not an obvious fix:** realized goodR over that
window was **0 / 67 bars** — mean 24h max excursion **0.66 ATR**, not one bar produced a ≥1.5-ATR
24h move. A 7.5% advance delivered as a slow grind. So ML_WIN was *correct* and loosening the gate
would **not** have produced a profitable trade last week. This is a correctness argument about an
internal contradiction, not a backtested edge claim. Treat any "it would have made money" framing
as unsupported.

## Pre-declared design

Conventions inherited from [[edge-methodology]] — mirror the fold boundaries, purge gap (48 bars),
and time-decay weights from `calibrate_v14.py`; no re-tuning per variant.

- **Data:** `csv_exports_v14/` (crypto, 77 symbols) and `csv_exports_v14_stocks/` (159 symbols).
- **Harness:** extend `ml-training/mixed_flat_test.py` — it already isolates the non-aligned cell.
- **Population:** non-aligned bars with calibrated ML_WIN in **[50, 70)**. This is the only
  population the change affects; bars <50 keep their own FLAT and bars ≥70 already pass.
- **Execution model:** the same 50%-off-at-TP1 / stop-to-BE / runner-to-TP2 model as
  `composite_band_backtest.py`, with counter-trend bands (TP1 1.0 ATR / TP2 2.0 ATR) and the
  MODERATE conviction cap, since that is what the opened window would actually trade.
- **Costs:** report gross **and** net at Binance ~0.10% round trip, plus the break-even round-trip
  cost. Per [[strategy-variance-harvest]] a thin gross edge that dies at fees is a rejection.
- **Folds:** 3-fold expanding-window walk-forward, and the 2022-bear fold reported separately.

### Variants (fixed in advance, no others)

| # | Change | Rationale |
|---|---|---|
| A | Incumbent: FLAT below 70 | control |
| B | Gate 70 → 60 | the cell's measured base rate |
| C | Gate 70 → 55 | just above the 50-60 bucket's realized 55.9% |
| D | Demote to a MODERATE cap for [50,70), hard FLAT only <50 | removes the redundancy with the existing <50 FLAT |

### Ship bar (declared before running)

Ship a variant only if, **against A**:

1. Net-of-fees EV/trade is **positive in all 3 folds**, and
2. Net EV/trade beats A by **> +0.02R**, and
3. It does **not** degrade the 2022-bear fold below A, and
4. Trade count rises by less than 10× (a gate that fires constantly is a different system, not a
   tuned one).

If two variants pass, ship the **more selective** one. If none pass, record it here and in
[[rejected-hypotheses]] and leave the gate at 70 — the internal contradiction is then an accepted
cost of not having evidence, which is the correct outcome under this project's rules.

## Explicitly out of scope

- The **chase guard** (`chase_into_extended_aligned_trend`). It fired 7× in the window, all
  blocking a SHORT into the 62.3k low, 5/7 correct (price rallied 3.2-4.3% in 24h). n=7, but there
  is no case for touching it.
- **Direction.** Every state in `mixed_flat_test.py` has P(up24) 48-53%. The opened window trades
  as a structure-led setup, never a directional call. See [[edge-leak-daily-candle]] for why that
  line is not negotiable.

---

## RESULTS (2026-08-23) — NONE PASS. Gate stays at 70.

Run via `ml-training/mixed_gate_test.py`, executing the design above without modification. ML from
the PRODUCTION scorer (`mlPredict` exported over all 870,170 v14 crypto bars) then passed through
the live calibration curve, so the population matches what the app actually gates on.

- 870,170 bars, **576,647 non-aligned (66%)**
- Population the gate affects (non-aligned, calibrated ML in [50,70)): **489,906 bars**

| variant | trades | gross EV | net EV | folds (net) |
|---|---|---|---|---|
| **A incumbent (FLAT <70)** | 0 | — | — | control |
| B gate 70→60 | 251,880 | **−0.0325R** | −0.0511R | −0.097 / −0.081 / −0.079 |
| C gate 70→55 | 398,423 | **−0.0320R** | −0.0506R | −0.067 / −0.101 / −0.077 |
| D MODERATE cap [50,70) | 475,038 | **−0.0255R** | −0.0441R | −0.046 / −0.114 / −0.064 |

Ship bar required net EV positive in ALL folds and beating A by > +0.02R. **Every variant is
negative in every fold.** Not close, no variant preferred, nothing shipped.

**Gross EV is already negative**, so this is not the usual "thin edge dies at fees" rejection — the
trades lose before costs. That is a stronger result than the bar required.

### What prompted the re-examination

A 12-month replay of the real envelope over BTC 4H bars (real per-bar ML, calibrated) measured
**86.6% of bars auto-FLAT — one bar in seven tradeable** — with this rule the single largest
contributor at **48.5% of all bars**. The user's read that it "fires too often" was correct on
FREQUENCY. It is now measured that loosening it is not the remedy.

*(Measurement note: a first pass fed RAW ML where production feeds CALIBRATED, inflating the
`ML_WIN<50` share from its true 26.8% to 71%. Corrected before reporting; mean ML 41.7% raw →
55.1% calibrated.)*

### Status of the internal contradiction

The contradiction identified 2026-07-24 is real and remains: the gate demands ≥70 to unlock a cell
whose own base rate is ~61%. It is now an **accepted cost with evidence behind it** rather than an
open question — which the design anticipated as the correct outcome absent a positive result.

### Honest caveat for any future re-run

The design pre-declared counter-trend bands of **TP1 1.0 ATR against a 2.0 ATR stop** — risking two
to make one on the first leg. With direction a coin flip, that geometry is structurally hard to win.
So this result says *"opening this window and trading it THIS WAY loses money"*, not *"MIXED bars
contain no edge"*. A geometry sweep would be a different experiment needing its own design and bar;
it must not be run by re-tuning this one after the fact.
