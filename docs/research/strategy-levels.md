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
