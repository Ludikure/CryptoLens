# Pre-declared: are DAILY CLOSES a real level class, or a location artifact?

**Status: PRE-DECLARATION. Written and committed before any number in the RESULT section
was computed.** Design + ship bar + predictions are fixed here first.

Related: [[strategy-levels]] (Findings 1-5), [[edge-methodology]], [[rejected-hypotheses]].

## The claim under test

`strategy-levels.md` Finding 4 (`ml-training/level_validation_htf.py`, 2026-05-31) measured
48h hold rate by level class against a random-line control:

```
CRYPTO (vs random 85.6%)        STOCK (vs random 79.9%)
  daily close   91.4%  +5.8       weekly close  85.9%  +5.9
  4H swing      89.8%  +4.2       daily close   85.6%  +5.7
  weekly close  88.6%  +3.0       weekly low    85.6%  +5.6
  weekly low    87.1%  +1.5       4H swing      85.1%  +5.1
  weekly high   85.9%  +0.3       weekly high   85.1%  +5.1
```

It concluded daily closes are "the strongest class, beating the 4H swings the app already
uses" and "the one genuinely actionable find", then filed it **NOT YET IMPLEMENTED —
pending decision**. Verified 2026-08-28: still unimplemented; `indicators-full.ts` builds
levels from swing pivots only.

## Why that table cannot settle it

The control is `dist = rng.uniform(0.5, 3.0) * atr` from the current close — a random
horizontal line 0.5-3.0 ATR away. A daily-close level differs from that control in **three**
ways at once, only one of which is the hypothesis:

1. **It is a price the market actually traded at** (it closed there). A random line
   0.5-3.0 ATR out may sit outside the recent traded range entirely.
2. **It sits at distance 0 from price when it forms.** The control never samples below
   0.5 ATR, so the two populations are not distance-matched.
3. It falls on a calendar day boundary. *This is the only one that is the hypothesis.*

So the +5.8pp is an upper bound on the daily-boundary effect and may be entirely (1) or (2).
This is the same confound the Fibonacci class died of — Finding 5 found fib levels looked
strong (+6.7pp, beating 4H swings) until controlled against **random retracement ratios in
the same legs**, at which point the ratios turned out to be flat and the whole thing was a
location artifact. The control that killed fib has no analogue here yet.

## The decisive control

**A random past 4H close.** It shares properties (1) and (2) with a daily close — a visited
price, drawn from the same tape, evaluated from a matched start bar — and differs only in
carrying no daily-boundary significance.

> If a random 4H close holds as often as a daily close, "daily close" is decoration, in
> exactly the sense the WORN/FLIP tags and the fib ratios were decoration.

## Arms

All through the IDENTICAL `forward_outcome` logic, same horizon, same touch/break/react
thresholds, both markets:

| arm | purpose |
|---|---|
| `daily close` | the claim |
| `4H swing` | the incumbent — what the app already uses |
| **`random 4H close`** | **decisive control** — visited price, no day boundary |
| `random line 0.5-3.0 ATR` | the original control, kept for comparability with Finding 4 |
| `random line, distance-matched` | isolates confound (2) |

## Ship bar — pre-declared

Daily closes get implemented as a level source only if **all three** hold:

- **(a) Magnitude.** Daily close beats **random 4H close** by **>= 2.0pp** on crypto.
  Rationale for 2.0: the entire real-level effect over random lines is 4.3pp (Finding 2),
  and daily close claims only +1.6pp over the already-implemented 4H swing. A class that
  cannot clear 2pp against a matched visited-price control is not adding a mechanism.
- **(b) Period consistency.** That gap is positive in **>= 7 of 9** half-year periods.
  This is the criterion that killed stop x target ([[stop-target-joint]]) at 5/10 and it is
  what separates a regime finding from a geometry finding.
- **(c) Replication.** Same sign on stocks. Cross-market replication is the vault's standing
  bar and only one finding has ever cleared it (entry discipline, [[entry-filter]]).

Partial support does not ship. If (a) passes and (b) fails, that is NOT SUPPORTED.

## Effective n

Levels overlap heavily and consecutive daily closes are autocorrelated — a level formed
Monday and one formed Tuesday can be a fraction of an ATR apart and be resolved by the same
price action. Nominal n will be large and mostly redundant. **Every reported figure must
state effective n**, per the standing rule from [[strategy-levels]] Finding 6 / the
2026-08-25c divergence correction, where dependent observations nearly produced a finding
three separate times. Clustering: by (symbol, half-year) block.

## Design refinement, added before running (on smoke-test evidence, no results seen)

The smoke test showed the day-boundary arm is **entirely one hour of the day** — on crypto,
every boundary bar closes at 00:00 UTC (the 20:00-24:00 bar), and the other five arms are
hours 00/04/08/12/16. That is a confound in this test's own design: the project already
knows time-of-day carries signal (`hourBucket` is a live feature, and `dayOfWeek` is crypto's
TOP permutation feature at +0.048, [[feature-pruning]]). A raw boundary-vs-rest contrast
could be an hour-of-day effect wearing a calendar hat.

Stronger form, adopted: **evaluate all six hour buckets as their own arms.** If the day
boundary is the mechanism, its hour stands ALONE above the other five. If the six are flat,
or ordered by something other than the boundary, it is not. Recorded here before the run so
the refinement cannot be mistaken for a post-hoc slice.

## Predictions, recorded in advance

1. **The daily-close advantage collapses against the random-4H-close control** — I expect
   under 2.0pp, i.e. arm (a) fails. Six separate level-strength metrics have already
   measured flat, and fib died to precisely this control design.
2. **If the effect were real it should be STRONGER on stocks than crypto.** Stocks have a
   genuine session close — settlement, closing auction, marked positions. Crypto's daily
   boundary is an arbitrary UTC cut on a 24/7 tape with no settlement and no auction. The
   Finding 4 table shows them nearly equal (+5.8 vs +5.7) and on stocks the *weekly* close
   beat the daily one. **An effect of equal size on a market that has the mechanism and a
   market that does not is evidence the mechanism is not what is being measured.**
3. Distance-matching alone will close a meaningful part of the gap, because hold rate should
   rise as a line sits nearer to price.
4. **The six hour buckets will be within noise of each other**, and the boundary hour will
   not stand alone.

If prediction 1 is wrong and the bar is met, that is a genuine finding and it ships.

## RESULT — NOT SUPPORTED. All three criteria fail.

`ml-training/level_daily_close_test.py`, full sample, both markets. Finding 4's original
table reproduces EXACTLY first (91.4 / 89.8 / 88.6 / 87.1 / 85.9 crypto), so this is a
control problem, not an arithmetic one.

### The decisive contrast: every 4H close as a level, split by day boundary

| | HOLD | n | eff_n (deff) |
|---|---:|---:|---:|
| **CRYPTO** daily close (day-boundary close) | 91.36% | 108,323 | 32,404 (3.3) |
| **CRYPTO** other 4H close (NOT a boundary) | **91.62%** | 540,280 | 90,470 (6.0) |
| | **GAP −0.26pp** | | ~1.4 SE, wrong sign |
| **STOCK** daily close | 85.65% | 158,698 | 41,594 (3.8) |
| **STOCK** other 4H close | 83.99% | 159,738 | 39,960 (4.0) |
| | **GAP +1.66pp** | | ~6.6 SE |

| criterion | bar | crypto | verdict |
|---|---|---|---|
| (a) magnitude vs matched control | ≥ +2.0pp | **−0.26pp** | **FAIL** |
| (b) period consistency | ≥ 7 of 9 | **4 of 10** | **FAIL** |
| (c) replication, same sign | both markets | crypto −0.26 / stock +1.66 | **FAIL** |

### What the +5.8pp actually was

**A visited-price artifact, as predicted.** Against the original random-line control, an
*arbitrary* 4H close scores **+6.95pp** — larger than the daily close's +6.69pp and larger
than the 4H swing's +5.13pp. Everything the market has recently closed at holds better than
a line it has not traded at. The calendar boundary contributes nothing on crypto.

All six hour buckets land in a 0.85pp band, and the boundary hour is the **second worst**:

```
00:00 91.40   04:00 91.20   08:00 91.65
12:00 92.05   16:00 91.79   20:00 91.36  <- the day boundary
```

Prediction 4 held: the six hours are within noise and the boundary hour does not stand alone.

### The stock effect is real, and it is not a calendar effect

+1.66pp at **10 of 10 periods** is not noise. But splitting by position within the session
(2-bar sessions only, so DST and half-days cannot smear it) locates it exactly:

```
morning bar   (session OPEN half)   HOLD 83.94%   n 158,888
afternoon bar (session CLOSE half)  HOLD 85.65%   n 157,114
                                    GAP  +1.70pp
```

+1.70pp reproduces the +1.66pp boundary gap almost exactly, so on stocks **"daily close
level" and "the afternoon bar" are the same object**. The mechanism is intraday — the
morning bar contains the open, the gap and the session's highest volatility, so a level
formed at its close is likelier to be run through — not "a daily level carries weight".

**Prediction 2 held, and it is the informative one.** I predicted that if the effect were
real it should be STRONGER on stocks, which have a genuine session close, than on crypto,
where the daily boundary is an arbitrary UTC cut on a 24/7 tape. It is: +1.66pp vs −0.26pp.
A boundary effect that appears only where a real session boundary exists, and vanishes where
the boundary is a convention, is evidence the convention was never the mechanism.

### Two corrections this forces

1. **Finding 4's headline is withdrawn.** "Daily closes are the strongest class, beating the
   4H swings the app already uses… the one genuinely actionable find" does not survive a
   matched control. Nothing shipped on it (it sat NOT YET IMPLEMENTED for three months),
   so no production behaviour was ever wrong — but it was one decision away from being.
2. **The `vs random` column in Finding 4 is weaker than it reads.** Every "+X pp" there is
   measured against a control of **n≈1,750** — se 0.86pp crypto / 0.96pp stock, so a 2σ
   band of ±1.7-1.9pp. The entire weekly-high-vs-weekly-low ordering (+0.3 vs +1.5) sits
   inside that band and should never have been read as a ranking.

### What survives

Finding 2 (levels beat random lines) and Finding 3 (it is a minor effect) both stand — this
sharpens them. The right statement is now: **prices the market has recently traded at hold
better than prices it has not, by ~7pp, and no way of selecting *which* traded price — day
boundary, week boundary, swing pivot, Fibonacci ratio, test count, flip role — has ever
measured better than the others.** Seven selection metrics tested, seven flat.

That is the same conclusion as Findings 1 and 5, reached from a third direction.

### Cost of this test

One pre-declaration, one script, ~15 minutes of compute. It closed a three-month-old
"pending decision" that would otherwise have shipped a level source on a control artifact.
