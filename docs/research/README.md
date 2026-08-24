# MarketScope Research Vault

Linked notes for the empirical research behind MarketScope's edge — backtest findings,
EV measurements, model decisions, and (critically) the **rejected** hypotheses and *why*
they were rejected. This is the "why" layer that doesn't belong in always-loaded
`CLAUDE.md`: it's the archive you consult when you ask "did we ever try X?" or "why
isn't the system doing Y?".

**This is plain markdown** — version-controlled with the code, readable by Claude Code,
and openable as an [Obsidian](https://obsidian.md) vault (point Obsidian at this folder
for the graph/backlink view). Links use `[[note-name]]` wikilink syntax.

## Conventions
- One idea per note. A finding, a rejected hypothesis, a methodology.
- Every empirical claim cites its script (`ml-training/*.py`) and the measurement basis
  (holdout / WF folds / sample size). No unsourced numbers.
- When a finding supersedes or rejects another, link both ways.
- Dates are absolute. "Pre-cost" and "survivorship" caveats stated where they apply.

## Map of content

### Edge & direction
- [[edge-methodology]] — frozen holdout, timestamp-split WF, the leakage trap. Read first.
- [[edge-leak-daily-candle]] — 🚨 the in-progress-candle leak that
  faked crypto direction. Read alongside the two notes below — it retracts them.
- [[edge-direction-primitive]] — bias ∪ dStoch union; the 12-primitive sweep. ⚠️ leak-tainted.
- [[edge-crypto-direction-model]] — dedicated direction head, 94.7% holdout. ⚠️ RETRACTED (leak).
- [[edge-stock-direction-rejected]] — same recipe → chance on stocks. The kill-test (clean).
- [[live-validation]] — the dual-gate scoreboard: turning backtest into a forward record.

### What the signal actually is
- [[strategy-variance-harvest]] — 🟢 the current truth: ML_WIN predicts *magnitude not
  direction*; barrier-ordering, shuffle-null, conditional-drift; the convex/trailing/pyramiding
  strategy; asymmetric downside-cascade drift + upside convexity; fees/venue decide viability.

### ML models
- [[ml-model-versions]] — v11 crypto / v13 stock, reliability tables, the "own-data" trap.
- [[ml-additive-heads]] — meta / quantile / conformal / direction heads; phase experiments.

### Strategy & execution
- [[strategy-targets-bands]] — band defaults, crypto runner widening, target selection.
- [[strategy-counter-trend]] — counter-trend reversal setups.
- [[strategy-levels]] — S/R validation: levels are real (+4.3pp vs random), tags are noise.
- [[strategy-mixed-gate]] — 🟡 OPEN: the `biases_MIXED` ML gate sits above the base rate of the
  cell it unlocks (ML≥70 = 6.3% of bars). Pre-declared test, nothing shipped, nothing measured yet.

### The graveyard
- [[what-we-tried]] — **START HERE for "has this been tested?"** Synthesis of every strategy and
  feature tried, grouped by the SIX WAYS a hypothesis dies. Read before proposing anything.
- [[rejected-hypotheses]] — everything tested and discarded, with the numbers that killed it.


## The 2026-08-23 arc — direction closed, crash signal characterised

Twenty pre-declared tests in one session. Read [[what-we-tried]] first for the synthesis.

**Strategy tests (all failed their bars):**
- [[regime-hold]] — multi-month trend holds. Captured the 2025-26 bear (+74.7% vs −67.8%) and lost
  it all in the chop. My funding prediction was refuted by −34.6pp.
- [[five-hypotheses]] — longer horizons · cross-sectional momentum · defensive flat · ML_WIN as
  size · selling volatility. Five for five.
- [[untested-four]] — multi-asset trend · crash probability · conditional direction · dynamic R:R.
  T3 caught two of my own false positives (wrong null, non-independent observations).
- [[vol-conditioned-tail]] — passed 5/5 criteria and was overturned by its controls.
- [[regime-rotation]] — rotation loses to equal-weight and ties random.
- [[mechanism-diversification]] — passed its bar, then the window sweep qualified it heavily.
- [[mechanism-portfolio]] — the permutation control INVERTED; a random allocation beat two of three.

**The crash-overlay arc (T9→T15) — the one thing that survived:**
- [[crash-overlay]] — 7/7 on a window that could not test the bull case.
- [[full-cycle-overlay]] — bull coverage added; failed the decisive bull-retention criterion but the
  underlying claim got STRONGER (benchmark window became representative).
- [[persistence-override]] — a lookahead in my own mask inverted the ranking; caught and corrected.
- [[t9-attribution-audit]] — 5/7. Signal real, protection EPISODIC (absent through five 2023-25
  drawdowns).
- [[tail-only-overlay]] — confirmation destroys the lead time that is the entire source of value.
- [[entry-filter]] — cheap errors, cheap benefits. The declared endpoint for the branch.
- [[continuous-sizing]] — a 25% floor fixed 2021 and destroyed 2022.

**Replication and attribution (T16→T20):**
- [[replication]] — **REPLICATES** leave-one-symbol-out on 4 assets; 9 of 15 crash clusters are
  asset-specific, so not one bet counted four times.
- [[mechanism-decomposition]] — signal is asset-specific price structure, not systemic stress.
- [[price-structure-decomposition]] — it lives in TREND/MOMENTUM (−0.0501 AUC); price structure is
  net NOISE; tail shape was **never in the feature set**.
- [[momentum-index]] — my linear position score failed; reported as my inadequate baseline.
- [[activity-index]] — activity projection also failed, on six FRESH assets. Both projections
  negative → the information is interactive, not linear.

**Structural premium:**
- [[funding-carry]] — the only mechanism needing no forecast. ~8% net covered at Coinbase; dead if
  the spot leg must be bought. `GET /basis` monitors it.

## The two caveats that touch almost everything
1. **Survivorship** — the symbol universe only contains instruments that trade today. No
   delisted tokens. Real, unmodeled, can't be fixed with the current data.
2. **Execution** — all R/EV figures are pre-slippage, pre-funding, measured on the raw
   24h direction or excursion. Live net-of-cost is lower. [[live-validation]] is the only
   thing that will measure the real gap.
