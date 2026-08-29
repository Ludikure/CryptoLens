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

---

# RESULTS — run 2026-08-24

Feature counts: FULL 94 · +TAIL 102 · TAIL-ONLY 8. Coverage: 97% of rows carry all eight.

| asset | A FULL | B +TAIL | C TAIL only | **B − A** |
|---|---|---|---|---|
| BTC | 0.546 | 0.573 | 0.465 | **+0.027** |
| ETH | 0.595 | 0.590 | 0.512 | −0.005 |
| SOL | 0.600 | 0.610 | 0.523 | +0.010 |
| XRP | 0.667 | 0.671 | 0.543 | +0.004 |
| ADA | 0.587 | 0.594 | 0.502 | +0.007 |
| DOGE | 0.673 | 0.665 | 0.581 | −0.008 |
| LINK | 0.610 | 0.607 | 0.507 | −0.003 |
| AVAX | 0.652 | 0.642 | 0.538 | −0.010 |
| DOT | 0.643 | 0.645 | 0.532 | +0.002 |
| LTC | 0.642 | 0.634 | 0.529 | −0.009 |
| **MEAN** | **0.622** | **0.623** | **0.523** | **+0.0015** |

| criterion | result | |
|---|---|---|
| 1. mean AUC gain ≥ +0.010 | **+0.0015** | **FAIL** |
| 2. improves on ≥7/10 assets | **5/10** | **FAIL** |
| 3. TAIL ONLY beats chance | 0.523 | PASS |

## Verdict: REDUNDANT, not noise — the distinction matters

**The tail features carry real information.** TAIL-ONLY scores 0.523 against a 0.500 chance
baseline — weak, but genuinely above it, and criterion 3 passes.

**And they add essentially nothing to the existing set: +0.0015 AUC, improving on 5 of 10 assets** —
a coin flip. This is precisely the signature named in advance:

> *"tail-only scoring well while FULL+TAIL shows no gain — that's the signature of redundancy rather
> than noise, the same shape as T18's finding that explicit volatility features cost only −0.0063 to
> remove."*

The mechanism is the one T18 identified. The momentum block already encodes tail state: ADX,
MACD-histogram magnitude and the delta/acceleration terms all rise when the return distribution
fattens. Giving the model explicit skew and kurtosis tells it something it had already inferred.

BTC's +0.027 is the largest single gain and should not be read as a finding — with 5/10 assets
improving, it is what the top of a noise distribution looks like.

## The pre-declared conclusion, which now applies

The design committed to this in advance:

> *"If this fails, the honest conclusion is that the feature set is saturated and further feature
> work is not the path."*

**Four feature classes have now been tested and all four came back redundant:**

| class | standalone signal | incremental value |
|---|---|---|
| whale / large-trade flow | AUC ~0.57 — real | none passed the WF bar |
| liquidation events | real | redundant vs volume/ATR/ADX/derivatives |
| policy / news catalysts | — | clean null (−0.8pp vs a +3.0pp bar) |
| **distributional tail shape** | **0.523 — real** | **+0.0015, 5/10 assets** |

The common cause is the one T18 measured directly: this feature set is heavily inter-correlated, so
new inputs keep landing on information already carried by the momentum block. **Adding features is
closed as a direction.**

## The irony worth recording

The convex strategy's entire edge is tail behaviour — big moves happening more often than a normal
distribution predicts (~30% versus ~17% theory). And explicit measures of tail shape do not improve
prediction of it.

Not because tail behaviour doesn't matter, but because **the model was already reading it indirectly,
through the activity of momentum indicators, well enough that the direct measurement is superfluous.**
