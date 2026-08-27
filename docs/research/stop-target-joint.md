# Stop × target, jointly — PRE-DECLARED 2026-08-27

**Nothing in "The test" or "The bar" below was written after seeing a result.** The prediction in
"What I expect" is recorded before running, so a wrong prediction is on the record as one.

## What prompted this

Two facts, both established before this test was designed.

1. **§9 of the corrected spec voids the old target table.** Its numbers were measured at a 2 ATR
   stop while LONG now ships 4 ATR, and re-measured at each side's real stop the sign REVERSES —
   wider is better on both sides, with every CI spanning zero. The rule it added is the reason for
   this test: *"stop and target INTERACT. Any change to one voids measurements of the other.
   Defaults stay at shipped values until a joint test is run."* This is that joint test.

2. **The app and the scanner price different trades.** `/opportunities` uses a **1 ATR stop at 5R**
   — the excursion model's own labels say `stop_atr: 1.0`, so its curve is only valid there. The
   analysis path uses **LONG 4 ATR / SHORT 2 ATR** at roughly 1.25–1.5R. Nothing reconciles them,
   and §9 forbids moving either lever alone to make them agree.

A third fact makes the question urgent rather than academic: on 2026-08-27 the LONG stop floor was
found to have made ordinary LONG setups **unemittable** (`viable` requires TP1 R:R ≥ 0.5 while every
TP1 band capped distance at 2.0 ATR, so TP1 R:R ≤ 2/stopAtr). That was a units bug and is fixed. But
it means the shipped LONG R:R has never actually been exercised in production, so "the shipped
values" are a default nobody has measured at the geometry they now run at.

## The test

**H1** — at each side's shipped stop, net R per opportunity is INCREASING in reward:risk across the
tested range.

**H0** — no monotone relationship, or the relationship is not stable across periods.

**Population.** Crypto, the 24 symbols with joint coverage in `csv_exports_v14` ∩
`vision_backfill/klines_long` — the same population every prior payoff test used. Arms are split by
`alignedDirection` from `envelope_exports_ml`, so each side is measured on its OWN bias population.
Direction-dependence has now shown up five times (C3, C4, C5, the excursion heads, the stop width);
measuring both sides pooled would hide it a sixth.

**Simulation.** `_payoff.simulate`, the module the excursion model's own labels were built with
(`module_version 1.0.0`), so this measurement and that model share a labelling implementation rather
than a reconstruction of one. `anchor='bar_close'` — the corrected anchor; the first actionable bar
is `base+4`, not `base+1`. `wait_h=12`, `hold_h=72`, `bar_hours=4`. Fees 0.171% round trip, with a
parallel **gross** build at 0.0.

**Grid**, fixed here and not to be extended after seeing results:

- stops — LONG {2.0, 3.0, 4.0, 5.0} ATR, SHORT {1.0, 2.0, 3.0} ATR. SHORT includes 1.0 so the
  scanner's geometry is measured in the same frame as the app's.
- reward:risk — {0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0}, so `tp_atr = stop × rr`.
- entry — market AND 0.25 ATR pullback. Parts 4-5 measured entry method as worth 40-60× the gating
  layer, so a target result reported at one entry only would be reporting the wrong variable.

**Primary statistic.** Mean `oppR` — R per OPPORTUNITY, with an unfilled setup scoring exactly 0.
Never mean `fillR`: a pullback rule only trades when price comes back, so judging it on filled
trades alone measures the survivors of its own selection.

**Effective n** per §21: `rows / (hold_h / bar_hours)` = `rows / 18`.

## The bar, fixed now

A (stop, R:R) pair replaces the shipped pair for a side only if **ALL FOUR** hold:

1. **Magnitude** — beats the shipped pair by ≥ **+0.02R** net at market entry.
2. **Period consistency** — better in ≥ **6 of 9** half-year periods, 2020-01 → 2026-07.
3. **Not fee arithmetic** — the GROSS series moves the same way.
4. **Power** — effective n ≥ **500** on that side.

**Stopping rule.** If any criterion fails, the shipped geometry stands and the result is filed in
`rejected-hypotheses.md`. **Partial support does not ship.** In particular a pair that wins on
magnitude but fails period consistency is a regime finding, not a geometry finding.

**No fitting.** This compares a small grid declared above. It does not select an argmax and ship it:
C6 established that walk-forward fitting of exactly this kind of threshold destroys it out of
sample, and the ML-floor arms converged on "no gate" when allowed to optimise.

## What I expect (recorded before running)

- **The shipped geometry stands.** §9's own re-measurement had every CI spanning zero, so I expect
  the +0.02R magnitude bar to fail on both sides.
- **Direction shape**: both sides improve as R:R widens, SHORT more weakly than LONG, because a
  wider target needs a bigger move and the tested window is a crypto bear where SHORT is the better
  side ungated — which flatters SHORT at every R:R equally rather than at wide ones specifically.
- **The useful output is the MAP, not a change**: what the app's ~1.25–1.5R actually costs or earns
  against the alternatives, and whether the scanner's 1 ATR / 5R is defensible in the same frame.

If the map shows the shipped R:R is materially worse than a neighbour AND that survives the four
criteria, the action is to move it. If it does not, the action is to record the map and leave the
defaults alone — and to state in the UI that the geometry is a default, not a measured optimum.
