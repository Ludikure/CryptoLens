# T21 — Do distributional TAIL-SHAPE features improve crash prediction?

**Status:** frozen 2026-08-24 before any computation.

## Why this is the strongest remaining hypothesis

Two findings from this project point at the same gap:

1. **T18 discovered the model has no tail measures at all.** The TAIL SHAPE group was near-empty —
   no skew, no kurtosis, no downside asymmetry, no tail-frequency count anywhere in the 110
   production features. Its removal cost −0.0005 AUC because there was nothing there to remove.
2. **The convex strategy's entire edge is tail behaviour.** Random-walk theory says a 1R-stop/5R-target
   trade should hit its target ~16.7% of the time and be a fair bet. The tail-gated version hits
   large targets **~30%** of the time. That gap — big moves being more frequent than a normal
   distribution predicts — is where +0.151R gross comes from.

So the model is asked to predict an **extreme** move (`P(10% drawdown in 10 days)`) using only
measures of **ordinary** ones. This test asks whether giving it the distribution's shape helps.

**The honest counter-argument, stated up front:** realised volatility already partially proxies tail
behaviour, and T18 showed this feature set is heavily redundant — the explicit volatility features
were near-worthless (−0.0063) *because the momentum block already carried that information*. Tail
features may be redundant the same way.

## The eight features — frozen here

Computed from 4H returns, backward-looking windows only, per asset.

| feature | definition |
|---|---|
| `tailSkew60` | skewness of returns, 60 bars (10d) |
| `tailKurt60` | kurtosis of returns, 60 bars |
| `tailSkew180` | skewness, 180 bars (30d) |
| `tailKurt180` | kurtosis, 180 bars |
| `tailDownUp60` | semi-deviation(down) ÷ semi-deviation(up) — downside asymmetry |
| `tailFreq60` | fraction of bars with \|r\| > 2× rolling sd — tail frequency |
| `tailMaxDD60` | worst peak-to-trough within the last 60 bars |
| `tailQSpread60` | (p95−p50) ÷ (p50−p5) — quantile asymmetry |

## Arms

**A. FULL** — the existing production feature set (the T17 arm-B price/vol block).
**B. FULL + TAIL** — the same set plus the eight above. *This is the test.*
**C. TAIL ONLY** — the eight alone, to see whether they carry standalone signal.

Identical folds, purge 72, LGB d4/t150, leave-one-symbol-out — the same framework as T17-T20.

## Universe

All ten assets used across T16-T20: BTC, ETH, SOL, XRP (the original four) and ADA, DOGE, LINK,
AVAX, DOT, LTC. Reported separately so neither group can quietly carry the verdict.

## Ship bar

Tail features earn their place only if **all** hold:

1. **AUC(FULL+TAIL) − AUC(FULL) ≥ +0.010** (mean across all ten assets). Smaller than the +0.020
   used in T19/T20 because this is an *incremental addition* to an existing set rather than a
   replacement for it — but large enough to be half the model's entire measured edge over a one-line
   volatility rule (+0.022).
2. The improvement appears on **≥7 of 10** assets.
3. **TAIL ONLY beats chance** (>0.520) — otherwise the features are noise and any apparent gain in
   arm B is a fitting artifact.

**Pre-registered expectation: genuinely uncertain, leaning negative.** The mechanism argument is the
strongest in the project — the target *is* a tail event and the model has no tail inputs. But every
new feature class tested here (whale flow, liquidations, news) has turned out redundant with what the
model already had, and volatility is a decent proxy for tail activity. **If this fails, the honest
conclusion is that the feature set is saturated and further feature work is not the path.**
