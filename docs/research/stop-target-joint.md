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

---

# RESULT — 2026-08-27. NOT SUPPORTED on both sides. The shipped geometry stands.

Scripts: `ml-training/stop_target_joint.py` (the map), `ml-training/stop_target_confirm.py` (the
four criteria). 24 crypto symbols, `anchor='bar_close'`, market and pullback entry, net of 0.171%.

## The map — net R per opportunity, market entry

**LONG** (55,752 bars, effective n 3,097):

| stop | 0.75R | 1.0R | 1.25R | 1.5R | 2.0R | 3.0R | 5.0R |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2.0 ATR | −0.0360 | −0.0376 | −0.0342 | −0.0301 | −0.0180 | +0.0020 | +0.0198 |
| 3.0 ATR | −0.0224 | −0.0179 | −0.0109 | −0.0042 | +0.0058 | +0.0182 | **+0.0255** |
| 4.0 ATR | −0.0114 | −0.0041 | +0.0020 | **+0.0069** | +0.0153 | +0.0192 | +0.0239 |
| 5.0 ATR | −0.0030 | +0.0042 | +0.0097 | +0.0146 | +0.0168 | +0.0209 | +0.0222 |

**SHORT** (79,992 bars, effective n 4,444):

| stop | 0.75R | 1.0R | 1.25R | 1.5R | 2.0R | 3.0R | 5.0R |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1.0 ATR | −0.0220 | −0.0135 | −0.0048 | −0.0030 | −0.0047 | −0.0097 | **+0.0191** |
| 2.0 ATR | −0.0087 | −0.0114 | −0.0147 | **−0.0149** | −0.0093 | +0.0027 | +0.0036 |
| 3.0 ATR | −0.0144 | −0.0170 | −0.0144 | −0.0096 | −0.0048 | −0.0043 | −0.0067 |

Bold = shipped, and the best cell per side.

## The verdict

| | SHORT: 2A@1.5R → 1A@5R | LONG: 4A@1.5R → 3A@5R |
|---|---|---|
| 1 magnitude (bar +0.0200) | **+0.0340**, CI [+0.0132, +0.0559] → PASS | +0.0186, CI [+0.0071, +0.0314] → **FAIL** |
| 2 periods (bar 6/9) | **5/10** → **FAIL** | **5/10** → **FAIL** |
| 3 gross moves the same way | +0.0692 → PASS | +0.0236 → PASS |
| 4 power (bar 500) | 4,444 → PASS | 3,097 → PASS |
| | **NOT SUPPORTED** | **NOT SUPPORTED** |

**Both fail period consistency at 5 of 10 half-year windows.** By the pre-declared stopping rule
that makes each a REGIME finding rather than a geometry finding, and partial support does not ship.
Filed accordingly; the shipped stops and targets are unchanged.

## The prediction was half right, and the half that was wrong is the interesting one

I recorded before running that "the shipped geometry stands" and that "the +0.02R magnitude bar
fails on both sides". The verdict held; the reasoning did not. **SHORT's magnitude bar PASSED and
passed clearly** — +0.0340R with a CI well clear of zero and a gross series agreeing at +0.0692. It
died on period consistency, which is a different failure and a more informative one: the effect is
real in aggregate over this window and is not stable within it.

## Four things worth carrying forward, none of them shipped

1. **The R:R gradient dominates the stop gradient, and nothing had measured it.** On LONG at a fixed
   2 ATR stop, moving 0.75R → 5.0R is worth **+0.056R** — larger than the entire 2→4 ATR stop-width
   effect (+0.0362R) that is the vault's best-validated result. Every cell improves monotonically in
   R:R, on every stop, on both entries. The project has spent its attention on the stop and has been
   measuring the smaller of the two levers.

2. **The app's shipped SHORT geometry sits in the worst region of its own grid.** 2 ATR @ 1.5R is
   −0.0149, and the entire 2 ATR row is negative until R:R 3.0. Not actionable here — it failed the
   bar — but a SHORT-side stop/target test with a period criterion it can pass is now the highest
   value item this map identifies.

3. **The scanner's geometry is vindicated on its own terms.** `/opportunities` prices a 1 ATR stop
   at 5R, and that is the single best SHORT cell in the grid (+0.0191). The two geometries in the
   product are not one good and one arbitrary — they are the best short cell and a poor one. That
   makes reconciling them a real decision rather than a tidy-up, and it is still blocked on a period
   criterion neither side passes.

4. **SHORT pullback entry is negative in every cell** (−0.0220 to −0.0526), against a market entry
   that reaches +0.0191. This independently reproduces the 2026-08-26 Phase 0 correction, which
   found entry discipline INVERTS on SHORT (−0.0123, 2/9) after the lookahead was removed. Two
   different scripts, two different populations, same sign.

## A defect in the shared payoff module, found by this test

`_payoff.align_arms` de-duplicated the KEY set but then LEFT-merged each arm undeduplicated, so one
repeated `(symbol, timestamp)` in a feature export multiplies the row set by 2 **per arm** —
`2**n`. `csv_exports_v14/AVAXUSDT.csv` contains exactly one, at 2026-05-06 00:00:00.

It fails silently in both directions, which is what made it hard to see. At this test's 98 arms it
is an instant `SIGKILL` (exit 137, no traceback, which reads as a hang). At the 12 arms
`phase3_stop_width_test.py` uses it does not crash at all — it would simply weight one bar 4,096
times.

**The shipped stop-width result was re-run with the fix and reproduces EXACTLY** — +0.0362R, CI
[+0.0245, +0.0484], 10/10 periods, 55,752 bars, effective n 3,097, all five criteria PASS. So that
finding is clean. The defect is real and demonstrated, and it did not reach a published number.
