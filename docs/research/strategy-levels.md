# Support/resistance levels — validated

The one major subsystem that hadn't been backtested, now measured. Script:
`ml-training/level_validation.py` (58k+ resolved level retests on the 4H candle archive).
Methodology: [[edge-methodology]]. Related strategy logic: [[strategy-targets-bands]].

## How levels are detected (the code)
Swing-pivot fractals (strict extreme vs N=3 bars each side, `MarketStructure.swift` /
`SupportResistance.swift`) → clustered by ATR proximity (`max(price*0.003, atr*0.1)`) →
tagged by test-count + FLIP_ROLE → blended with VWAP, volume-profile POC/VAH/VAL, Fib →
tagged by proximity (IN_PLAY/NEARBY/DISTANT). Everything ATR-relative.

## Finding 1 — the strength TAGS predict nothing
Hold rate (price rejects ≥0.5 ATR before closing ≥0.5 ATR through, 48h horizon), grouped
by tag:
```
                    CRYPTO (36,109)        STOCK (22,642)
test-count 1        89.1%                  84.6%
test-count 2        88.5%                  84.7%
test-count 3+       88.7%                  83.6%      ← WORN heuristic: FLAT
FLIP_ROLE           89.4%                  83.7%      ← stock flip slightly WORSE
non-flip            88.8%                  84.6%
```
The `WORN_Nx_distrust` rule (distrust heavily-tested levels) has **no empirical basis** —
3+-tested levels hold as often as fresh ones. `FLIP_ROLE`-stronger is unsupported (and
backwards on stocks). **The tag taxonomy is decoration.**

## Finding 2 — but the levels themselves are REAL
Control: random horizontal lines (not on any swing), same distances, same outcome logic.
```
                    CRYPTO          STOCK
real swing levels   88.9%           84.5%
random lines        84.6%           80.2%
                   ───────         ───────
levels beat random  +4.3pp          +4.3pp   ← identical on both markets, independently
```
Swing levels hold ~4.3pp more than random price lines — consistent across both markets, so
real, not luck. The detection is valid: levels are genuine entry/target **locations**.

## Finding 3 — but levels are a MINOR effect
~84% of *random* lines also "hold" by this metric → the bulk of S/R-holding behavior is the
price process (volatility/mean-reversion); structure adds only a few points. Levels are
worth using as locations, not as a powerful filter. Don't over-weight them.

## Finding 4 — higher-timeframe levels: daily wins, weekly folklore fails
`ml-training/level_validation_htf.py` tested daily-close + weekly (close/high/low) classes
vs the 4H swing baseline and random, all through the identical forward-outcome logic.
```
CRYPTO (vs random 85.6%)            STOCK (vs random 79.9%)
  daily close   91.4%  +5.8  best     weekly close  85.9%  +5.9  best
  4H swing      89.8%  +4.2            daily close   85.6%  +5.7
  weekly close  88.6%  +3.0            weekly low    85.6%  +5.6
  weekly low    87.1%  +1.5            4H swing      85.1%  +5.1
  weekly high   85.9%  +0.3  ~random   weekly high   85.1%  +5.1
```
Takeaways:
- **Daily closes are the strongest class**, beating the 4H swings the app already uses
  (+5.8 vs +4.2pp crypto; +5.7 vs +5.1 stock). The one genuinely actionable find.
- **"Weekly > daily > 4H" is FALSE.** On crypto it's daily > 4H > weekly. Higher TF ≠
  stronger level.
- **Weekly highs/lows are weak-to-random on crypto** (weekly high +0.3pp = noise). Crypto
  trends 24/7 and blows through weekly extremes — consistent with the momentum thesis
  ([[edge-crypto-direction-model]]). Stocks (mean-reverting) respect weekly levels fine.
- Still a minor effect overall — everything in an 85-91% band over an 80-86% floor; which
  timeframe barely matters.

Conclusion: adding **daily closes** as a level source is defensible (best class, marginal
edge over existing 4H swings). Adding **weekly** is not justified — weekly close helps only
on stocks, weekly H/L not at all on crypto. NOT YET IMPLEMENTED — pending decision.

> ## ⚠️ FINDING 4 WITHDRAWN (2026-08-28) — see [[level-daily-close]]
>
> The daily-close conclusion above **does not survive a matched control** and is retracted.
> The comparison is against random lines 0.5-3.0 ATR from price, so a daily close differs
> from the control in three ways at once — visited price, distance 0 at formation, day
> boundary — and only the third is the hypothesis. Exactly the confound that killed the
> Fibonacci class in Finding 5.
>
> Decisive contrast (every 4H close evaluated as a level, split by whether its bar is the
> last of the day — perfectly matched, exhaustive):
>
> | | daily close | other 4H close | gap |
> |---|---:|---:|---:|
> | crypto | 91.36% | **91.62%** | **−0.26pp**, 4/10 periods |
> | stock | 85.65% | 83.99% | +1.66pp, 10/10 periods |
>
> **On crypto an arbitrary 4H close scores +6.95pp vs the random control — BETTER than the
> daily close (+6.69) and better than the 4H swing (+5.13).** The +5.8pp was a visited-price
> artifact. All six hour-of-day buckets sit in a 0.85pp band with the boundary hour second
> worst.
>
> The stock gap IS real at 10/10 periods, but splitting by within-session position shows it
> is the **afternoon bar vs the morning bar** (+1.70pp, reproducing the gap almost exactly) —
> an intraday effect, not a calendar one. It does not generalise to a 24/7 tape.
>
> Also note: the `vs random` column above rests on a control of **n≈1,750** (2σ ≈ ±1.7pp),
> so the weekly-high/weekly-low ordering inside it was never a ranking.
>
> Nothing shipped on Finding 4 — it sat unimplemented for three months — so no production
> behaviour was wrong. Levels remain swing-pivot-only, which this now supports.


## Finding 5 — Fibonacci ratios add NOTHING (location artifact)
`ml-training/level_validation_fib.py`. Fib retracement levels first looked great (crypto
+6.7pp, even beating 4H swings), with 0.618 nominally best. But the ratios were nearly
flat (0.236 ≈ 0.618) — the tell. The decisive control: **random retracement ratios in the
same legs**.
```
                        CRYPTO          STOCK
fib (all ratios)        91.6% +6.7pp    85.1% +6.5pp
RANDOM ratio same leg   91.6% +6.6pp    84.9% +6.3pp
fib beats random ratio  +0.1pp          +0.2pp   ← zero, on 450k/240k samples
```
The entire apparent edge is the **mid-range location** (any line inside a recent swing
range holds +6.6pp over a far random line), NOT the Fibonacci ratios (+0.1pp = noise).
0.618 "best" was noise; golden-ratio mysticism is pareidolia. Fib levels are valid
mid-range levels but add nothing over the swings they're computed from — redundant, not
harmful (unlike the worn tags, no false signal — except the "Fibonacci" *label* may make
the LLM over-weight ordinary levels). Candidate: de-emphasize the Fib framing in the prompt.

## Finding 6 — snapping targets to S/R LOWERS EV (the one that matters)
`ml-training/setup_execution_snap_test.py`. Everything above is hold-rate (secondary);
this is EV. Same swing-reversal entries, two target schemes, full execution model (50% at
TP1 → BE stop → runner to TP2):
```
                  CRYPTO                    STOCK
  ATR band   EV -0.0010R  win 40.4%    EV +0.0309R  win 41.1%
  snap S/R   EV -0.0051R  win 49.2%    EV +0.0160R  win 47.0%
  snap−ATR   -0.0040R/trade            -0.0149R/trade
```
**Snapping raises win rate but lowers EV on both markets.** Snapping pulls the target
closer → hit it more often, but each win is smaller; the fixed ATR target's bigger runners
more than pay for its lower hit rate. So for target placement, S/R-snapping is a *drag* —
the bands do the work. "Put your TP at the next resistance" is the wrong instinct for EV.

Caveats: generic swing entries (near-zero edge — the *comparison* is the valid part, not
the absolute EV); naive nearest-level snap, not the app's 3-layer quality picker. Strongly
disproves naive snapping; casts doubt on snapping generally. Before any production change,
port the actual picker and A/B vs pure ATR — but the burden of proof is now on the picker.
Relates to the flagged `levelStrength` weight (`AnalysisPrompt.swift:2156`).

## Finding 7 — VOLUME doesn't predict level strength either (the capstone)
`ml-training/volume_at_level.py` on freshly-fetched daily OHLCV with volume
(`fetch_daily_volume.py` → Binance + Yahoo; data gitignored). Two volume notions, both the
strongest-mechanism candidates for "level strength," within-symbol terciles:
```
CRYPTO (21k levels, base 90.7%)        STOCK (52k, base 87.3%)
 formation vol  lo91.6 mid90.8 hi89.5   lo87.6 mid86.9 hi87.3   high−low -0.2pp
                high−low -2.0pp
 vol-at-price   lo89.7 mid91.4 hi90.9   lo87.8 mid87.0 hi86.9   high−low -0.9pp
                high−low +1.1pp
```
Flat — ±1-2pp, non-monotonic, inconsistent sign. The volume-profile "high-volume node =
strong S/R" thesis does not hold. **Six strength metrics now tested — test-count, flip,
timeframe, Fib ratio, formation volume, volume-at-price — and NONE predict hold/break.**

## The verdict on level "strength"
Level *strength* as conventionally conceived in TA is a **myth in this data** — levels
cannot be ranked by reliability. Only two things about S/R are real:
1. Being an actual structure location beats random by +4-6pp (modest, consistent).
2. For targets, do NOT snap to levels — it trades EV for win rate (Finding 6).
Everything else (how many tests, flip, timeframe, Fib, volume) is noise.
Caveat: strength tested vs the *binary* hold/break; not vs reaction magnitude or EV — but
the binary is dead flat across all six metrics and bounce-magnitude splits were flat too.

## Actions taken (2026-05-31)
- **Neutralized** the prompt strength tags in `AnalysisPrompt.swift`: `WORN_Nx_distrust` /
  `FRESH_1x_strongest_reaction` / `RECENT_Nx` → neutral `tested_Nx` fact; `FLIP_ROLE` kept
  as a neutral structural label (was both a swing high and low), strength framing dropped.
  "Worn Levels" line → "Structure Levels".
- **Removed** the `entry_at_worn_level_4+_tests` conviction-envelope downgrade — it was
  capping conviction on the false premise that worn levels break more.
- **Left (flagged for follow-up):** the target-selection `levelStrength = tests × tfWeight`
  weight (`AnalysisPrompt.swift:2156`). Target-wall quality ≠ hold/break exactly, and target
  selection was backtested as a bundle — changing it needs its own target-specific test, not
  this indirect evidence.

## Caveats
- Hold/break is one threshold definition; the high ~85% base reflects that immediate
  decisive breaks are the minority. The **flatness across tags** and the **+4.3pp vs
  random** are robust to the exact threshold.
- Slight asymmetry: real events are "second touches" (price was at the level), controls are
  "first approaches." The direction of both findings is solid; the exact +4.3pp would tighten
  with a same-touch-type control. Logged in [[rejected-hypotheses]] (the tags).
