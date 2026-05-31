# Counter-trend reversal setups

When 4H reverses against the daily, the system can take a counter-trend reversal — but only
under tight conditions. Methodology: [[edge-methodology]]. Band logic it overrides:
[[strategy-targets-bands]].

## The finding
Backtesting (850K+ crypto, 192K+ stock bars) shows counter-trend setups (4H reverses vs
daily) have **73–86% goodR vs 38–43% for aligned** setups. Counter-trend at a reversal
point, when the ML quality gate is high, is a genuinely better entry than continuation.

## The rule
Counter-trend reversal allowed when **ML_WIN ≥ 70%**, with:
- Tighter targets: TP1 1.0 ATR, TP2 2.0 ATR.
- Conviction capped at **MODERATE**.
- Its own dedicated band block (not the [[strategy-targets-bands]] default inversion).

The ML≥70% gate is what makes it safe — without the quality filter, "catching the reversal"
is just fading a trend. With it, the high-goodR cell is selected.

## Relationship to direction signals
Counter-trend is a *structural* entry pattern; the direction primitives
([[edge-direction-primitive]]) and the crypto direction model
([[edge-crypto-direction-model]]) are *momentum* signals. They can agree (a fresh Stoch
cross at a 4H reversal against a tired daily) or conflict (Stoch still trend-aligned) — the
conviction envelope arbitrates.
