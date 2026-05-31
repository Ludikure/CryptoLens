# Target selection, bands & runner widening

How TP1/TP2/stop levels are chosen, and the EV work behind the band defaults. The
*execution* half of the edge (the *direction* half: [[edge-direction-primitive]],
[[edge-crypto-direction-model]]). Methodology: [[edge-methodology]].

## Three-layer target selection
Replaced naive "nearest 3 levels". In `AnalysisPrompt.swift` / target logic:
- **Layer 1** — hard R:R/ATR band constraints (TP1 1.0–2.5, TP2 1.8–4.0).
- **Layer 2** — quality scoring (1.5×strength + rrFit + clearance + freshness).
- **Layer 3** — ATR fallback with snap-to-nearest-level.
- Confluence: levels within 0.3 ATR merge into reinforcing clusters; obstacles penalized
  by strength; counter-trend uses tighter bands ([[strategy-counter-trend]]).

## Band-default inversion (2026-05-29)
Per-symbol EV on `csv_exports_v11` + `csv_exports_v13` (n=237): **86% of symbols** gain
≥ +0.01 R/trade from tighter DOGE-style bands (TP1 1.5 / TP2 2.5 / stop 2.0 ATR) over the
historical wide defaults (TP1 2.0 / TP2 4.0). `useTighterBands(symbol:)` is the switch.
`trendingSymbols` whitelist (~17: GLD, COIN, PFE, GME, CAT, JUP, INTC, MU, HBAR, NEO, ENJ,
CMG, TIA, TEAM, XLC, SNAP, ON, NVDA) opt back to wide. (Was A/B-gated; now universal post
A/B collapse — [[rejected-hypotheses]].)

## Crypto runner widening (2026-05-30)
`ml-training/composite_band_backtest.py` models the actual execution (50% off at TP1, stop
trails to BE, runner to TP2) on the clean multi-fold WF incl. 2022 bear. Once TP1 books and
the stop is at BE, the runner is **downside-free** → a wider TP2 only adds upside:
- **Crypto** blended EV +1.29R → **+1.37R** going 2.5→3.0 ATR (+1.42R at 3.5; knee ~3.0–3.5).
  Ships at ideal 3.0 ATR (band 2.0–3.5, R:R cap 1.75).
- **Stocks** gain only +0.007R from the same widening and carry overnight gap risk through
  the BE stop → left at 2.5 ATR.
`isCrypto = symbol ends in USDT`.

## BB-extreme — don't fade band touches (2026-05-30)
When `dBBPercentB ≤ 0.1 or ≥ 0.9`, the prompt emits "DO NOT short this — fading band
touches LOSES money (−0.052R EV)". Treat as continuation, not fade. Related dead-end:
exhaustion gate in [[rejected-hypotheses]].
