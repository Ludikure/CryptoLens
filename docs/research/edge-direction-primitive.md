# Direction primitive — bias ∪ dStoch union

How the system decides LONG vs SHORT for notifications. Co-equal union of two signals,
not a single primitive. Measured by `ml-training/direction_primitive_sweep.py` (12
primitives, 4.4 yr) and re-validated leakage-free by `edge_revalidate.py`. Methodology:
[[edge-methodology]]. The ML *model* version of direction: [[edge-crypto-direction-model]].

## The rule
```
notificationDirection(biasAlignment, dStochCross) → +1 / -1 / 0
  if bias and Stoch both fire and disagree → 0 (skip)
  else                                     → bias direction if set, else Stoch direction
```
Lives in `marketscope-worker/src/index.ts` (`notificationDirection`) and the iOS prompt
(`AnalysisPrompt.swift` STOCH_CROSS block). The notification gate and the LLM see Stoch
the same way.

## Why the union (the sweep)
Union of `bias OR dStochCross` beat all 11 alternatives on **total R captured**:

```
STOCKS (159 symbols, 11,498 rising-edge ML events)
                                  n      win%   EV/trade   total R
bias-aligned (former prod)       613    44.7%   +0.079R     +48.4
dStochCross alone              2,974    49.7%   +0.190R    +566.3
union (current prod)           3,339    49.2%   +0.179R    +599.2   ← 12× total R

CRYPTO TOP-10 (3,541 rising-edge events)
bias-aligned (former prod)       789    82.3%   +1.040R    +820.4
dStochCross alone                912    81.0%   +0.998R    +910.4
union (current prod)           1,517    81.9%   +1.024R   +1,553.1  ← 1.9× total R
```

Per-trade EV is nearly identical across primitives; the union wins by **firing more
often** without diluting EV. Clean re-run (timestamp split, 14-day embargo): dStoch
stocks +0.190→+0.189R, crypto +0.998→+0.995R; total-R multiple 12×→**18.7×** (stocks) /
1.9× (crypto). dStoch is +0.91R in the 2022-bear fold — regime-robust, not bull-only.

## Why bias differs on stocks vs crypto
Bias is a 6-layer composite (`ScoringFunction.swift`: EMA, ADX, RSI/MACD, VWAP, OBV/AD,
+ crypto: cross-asset + derivatives). On **stocks** it has fewer confirmation channels
(no derivatives/cross-asset), so it's restrictive — fires on ~5% of rising-edge ML bars.
Stoch picks up direction on the other ~25%. On **crypto** all 5 lenses align together
more often, so bias & Stoch agree 88% of the time when both fire (vs 53% on stocks). This
orthogonality on stocks is *why* the union captures 12× more there.

## Rejected primitive alternatives
See [[rejected-hypotheses]] for the full table (hStochCross, hMacdCross, dEmaCross, dStack,
dDivergence, bias-AND-Stoch intersection, and the Stoch-only notification gate that was
shipped and rolled back same-day for −80% R).

## Notification cadence
~6.6 dual-gate signals/month per crypto symbol on the holdout (BTC ~7.2); short-skewed in
the current regime. 4H rising-edge crosses **cluster** on the same move, so this overstates
independent opportunities. Measured by `ml-training/dual_gate_frequency.py`. The forward
record of these signals: [[live-validation]].
