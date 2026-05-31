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
- [[edge-direction-primitive]] — bias ∪ dStoch union; the 12-primitive sweep.
- [[edge-crypto-direction-model]] — dedicated direction head, 94.7% holdout, leakage audit.
- [[edge-stock-direction-rejected]] — same recipe → chance on stocks. The kill-test.
- [[live-validation]] — the dual-gate scoreboard: turning backtest into a forward record.

### ML models
- [[ml-model-versions]] — v11 crypto / v13 stock, reliability tables, the "own-data" trap.
- [[ml-additive-heads]] — meta / quantile / conformal / direction heads; phase experiments.

### Strategy & execution
- [[strategy-targets-bands]] — band defaults, crypto runner widening, target selection.
- [[strategy-counter-trend]] — counter-trend reversal setups.
- [[strategy-levels]] — S/R validation: levels are real (+4.3pp vs random), tags are noise.

### The graveyard
- [[rejected-hypotheses]] — everything tested and discarded, with the numbers that killed it.

## The two caveats that touch almost everything
1. **Survivorship** — the symbol universe only contains instruments that trade today. No
   delisted tokens. Real, unmodeled, can't be fixed with the current data.
2. **Execution** — all R/EV figures are pre-slippage, pre-funding, measured on the raw
   24h direction or excursion. Live net-of-cost is lower. [[live-validation]] is the only
   thing that will measure the real gap.
