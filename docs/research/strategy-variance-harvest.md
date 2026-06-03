# Variance harvesting — what the ML signal actually monetizes

**Investigated 2026-06-02.** After the direction edge turned out to be a leak
([[edge-leak-daily-candle]]), the question became: *is the surviving
ML_WIN signal tradeable at all, and if so, how?* The answer, derived from first-passage,
shuffle-null, and conditional-drift analysis: **the model predicts movement magnitude, not
direction; the edge is harvested by a convex, direction-agnostic, trend-following structure;
and at retail crypto fees it lives or dies on the venue.** Methodology: [[edge-methodology]].

## 1. ML_WIN is a volatility detector, not a directional one
`goodR = fwdMaxFavR ≥ 1.5` — P(a ≥1.5 ATR move within 24h). Clean top-bucket **76.4% vs ~51%
base**. But it answers *"how likely is a meaningful move?"* not *"which way?"* — proven by
first-passage barrier ordering (`ml-training/barrier_ordering.py`, 646k clean bars):

```
ML_WIN bucket   P(reach +1.5 ATR)   +1.5/-1 first   +1/-1 first   Stoch-called +1.5/-1
[0.0,0.5)            51%                 38%            48%             39%
[0.7,1.0)            64%                 39%            48%             43%
random-walk null      —                 40%            50%             40%
```
`P(reach)` **climbs 51→64%** with score (real information) while the **ordering columns sit
pinned at the random-walk null** and *don't move with score* — even when a directional filter
(daily Stoch cross) picks the side. The move gets more likely; *which barrier comes first stays
a coin flip.* (Note the asymmetric-barrier null: +1.5/-1 is 40% fav by gambler's ruin
`b/(a+b)`, not 50%.)

### Corollary: fixed brackets are mathematically dead
At the 40% null, a +1.5R/−1R bracket has EV `= 0.40·1.5 − 0.60·1 = 0` gross → negative after
costs. This is *why* every fixed-take-profit cell in the sweeps lost. You cannot cap the winner
and beat a coin flip.

## 2. The strategy that works: tail-gated, convex, trailing, pyramided
- **Gate:** a *tail* model (target `fwdMaxFavR72H ≥ 5`, top-decile realized 29% vs 17% base) —
  ML_WIN predicts the *body* (the 1.5 ATR move that hits your stop); the tail model leans at the
  *tail* (the 5+ ATR run that pays). Gating on ML_WIN directly *hurts* the convex trade
  (−0.110 vs −0.061); the tail gate helps. `strategy_clean_test.py`, `strategy_tail_test.py`.
- **Structure:** direction-agnostic entry (long+short averaged = the EV of not knowing
  direction, which is correct since direction is random), **1 ATR initial stop**, **2 ATR
  trailing stop**, **pyramid** into confirmed winners (add every 1.5 ATR, max 2).
- **Net (Binance fees ~0.13%, clean WF, `strategy_pyramid.py`):**
  ```
  single-shot trailing                 +0.060 R/signal
  + pyramiding (add 1.5 ATR, max 2)     +0.216 R/signal
  + breakout-reset re-entry             +0.157 R/signal
  re-entry after stop (blind)           HURTS (−0.031 .. −0.061)
  ```
- **Profile (the honest catch):** trailing exit → **31% win rate, median trade −1R**; the +EV
  comes entirely from the ~31% that trail out at **+2.3R avg**. Pure trend-following payoff:
  wrong 2 of 3 times, profitable through asymmetry. Behaviorally brutal; a bot can take every
  signal, a human won't.

## 3. The edge is PATH structure, not fat-tail marginals (shuffle null)
`strategy_pyramid_null.py`: shuffle the *order* of each trade's forward bars (preserves the
exact fat-tail magnitude distribution + endpoints, destroys momentum/clustering).
```
paths       single   pyramid   pyr per-unit-bar (capital-normalized)
REAL        +0.060   +0.216    +0.0201
SHUFFLED    -0.080   -0.084    -0.0082
```
- **Pyramiding is real, not leverage:** capital-normalized it earns **2.3×** single-shot
  (+0.0201 vs +0.0087/unit-bar) and beats flat-3× (+0.216 vs +0.179) at only **1.6 avg units** —
  conditional sizing into winners *without* levering the losers.
- **The whole edge is path-dependent:** shuffling drives both to **negative**. It is *not*
  fat-tail magnitude harvesting (that would survive a shuffle). It requires real temporal
  structure. *(A path-dependent strategy with an order-independent edge would have been the
  surprise; this is the expected, reassuring result.)*

## 4. WHAT path structure — the fork resolved (conditional drift)
The shuffle proves *path matters* but not *which* path property (drift vs vol-clustering vs
regime vs cascades — all survive-destruction-the-same). `ml-training/conditional_drift.py`
isolates it: condition on the first ±0.5 ATR excursion, measure subsequent drift **by
direction**.
```
TAIL-GATED            continue%   drift@24h   drift@48h     (null 50%, 0.000)
first move UP            53%       +0.080      +0.030   ← weak, FADING   → convexity
first move DOWN          57%       +0.265      +0.368   ← strong, GROWING → real drift
```
**Asymmetric.** Up-moves chop (near-random drift, you earn the *convexity* under elevated
variance); down-moves **cascade** (genuine, growing downside drift — liquidation/margin
dynamics). Tail-score *amplifies the downside drift* (baseline +0.088 → gated +0.265). So:

> You can't predict the move. Once it starts, **up-moves chop (earn convexity) and down-moves
> cascade (earn drift)** — and the model's high scores concentrate the cascades.

This reconciles everything: **entry direction is random** (§1), but a *0.5 ATR move that already
happened* reveals a regime that persists mildly up / materially down. That's why **pyramiding
works** (presses an established, persisting move) while **blind re-entry fails** (re-bets the
random *start*).

### Consequence: the edge is disproportionately short-side
Most of the EV is the short leg pyramiding into downside cascades. That carries real,
unmodeled risk: borrow/funding spikes in crashes, short-squeeze tails, and **regime
dependence** — in a relentless grind-up with no cascades the drift engine goes quiet and only
the thin upside convexity remains. A cascade-momentum edge is more decay-prone than a
structural one (exchanges actively dampen cascades: ADL, circuit breakers).

## 5. Fees are the binding constraint — venue decides viability
All R figures are pre-slippage EV per signal; the edge is thin, so cost tier is decisive.
`strategy_stop_sweep.py` (env `COSTS=`):
```
round-trip cost     best net R/signal      verdict
Coinbase Intro-1  ~0.23–0.28%   −0.04 .. −0.07   dead — fees eat the edge
break-even        ~0.165%        0.000
Binance regular   ~0.06–0.13%   +0.067 .. +0.111  viable
```
Coinbase Intro-1 **derivatives** = 0.100% taker / 0.095% maker per side (maker/taker spread is
trivial, so maker doesn't rescue it). Binance regular-user **USDⓈ-M futures** = 0.020%/0.050%
USDT, **0.000%/0.040% USDC** — 3–5× cheaper, squarely in the viable zone. At Binance fees
*slippage becomes the dominant cost* (fees ~0.07%, slippage assumed 0.03%) — the next thing to
stress-test.

### Note on "wide targets" — they're a cap, not a level (`strategy_outcome_breakdown.py`)
An ATR here ≈ 2.87% of price, so 8/12 ATR ≈ 23%/34% moves — reached only 7%/2% of the time and
*hit as targets* 4%/1%. The "TP12" winner of the sweep almost never fills; 73% stop, 26% exit
at the 72h mark. The trailing-stop test (§2) replaces that idealized exit and the edge survives
(**+0.060, only 2% time-capped**) — so it was not a mark-to-market artifact.

## What's proven vs still open
**Proven (clean WF):** entry has no directional first-passage edge; the edge is path-dependent;
it's asymmetric (downside drift + upside convexity); pyramiding is genuine capital-efficient
amplification; viable only below ~0.16% round-trip cost.
**Open (backtest can't answer):** slippage realism at Binance fees; **regime decay** of the
cascade-momentum component (needs live monitoring, not set-and-forget); survivorship (no
delisted tokens — biases downside-cascade EV *optimistically*); and the behavioral reality of a
31%-win-rate system. [[live-validation]] is the only thing that closes these.

## Scripts
`barrier_ordering.py` · `wick_diagnostic.py` · `strategy_clean_test.py` · `strategy_tail_test.py`
· `strategy_stop_sweep.py` · `strategy_outcome_breakdown.py` · `strategy_trailing.py` ·
`strategy_reentry.py` · `strategy_pyramid.py` · `strategy_pyramid_null.py` · `conditional_drift.py`
(all `ml-training/`, on `csv_exports_v11_fixed` + `crypto_candles_4h.csv.gz`).
