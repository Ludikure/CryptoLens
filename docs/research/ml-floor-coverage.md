# Re-express the ML floor as COVERAGE — PRE-DECLARED 2026-08-26

**Nothing below was written after seeing a result.** No number in this document has been computed.

## Why

The envelope's hard floor is `calibrated ML_WIN < 50 → auto-FLAT`. It was built to reject the
weakest ~45% of bars. It now rejects **8.0%**.

Nothing was decided to cause that. `src/calibration.ts` refits a PAV curve from live forward outcomes
on every use — correctly, and it is what fixed the 2026-08-21 missed rally. But the CUTOFF on that
curve stayed at a fixed level while the SCALE underneath it moved: the live base rate runs ~58%
against v14's 50.5% training base, so raw maps upward and `calibrated 50` now corresponds to
**raw 30.3%**. The 2026-08-21 note called it *"a ~5× loosening nobody decided"*, and the loosening has
been in force since.

The user hit it directly: a BTC bar displaying raw ~30 produced setups. That bar calibrates to
almost exactly 50 — the most marginal bar that can still pass — and Phase 2 measured raw-<35 SHORT
bars at **−0.0532R with the interval clear of zero**, the worst cell in the table.

A level on a moving scale cannot hold its meaning. A **coverage** cut can.

## What changes

`ML_WIN < 50` becomes `ML_WIN below the Nth percentile of the live prediction distribution`, with the
percentile FIXED at the gate's original design intent.

    COVERAGE_FLOOR = 0.45      reject the weakest 45% of live predictions

**0.45 is not fitted and must never be.** It is the selectivity the gate was built with, recovered —
`envelope.ts`'s floor was designed against v14's training distribution where `< 50` rejected ~45%.
C6 established that walk-forward fitting of this threshold destroys it: on SHORT the out-of-sample
result swung across a 0.34R range period to period on a signal whose whole size is 0.05R, and on LONG
the optimizer picked the loosest available threshold every single time. **Re-optimising this number
is the failure mode, not the fix.**

## The five defects of the reverted Part 11 attempt, and how this avoids each

Part 11 shipped a coverage cut and it was reverted the same day. Each defect is a requirement here:

| Part 11 defect | requirement |
|---|---|
| measured on ALL bars, shipped on SHORT only → realised ~24% selectivity | applies to **every bar**, exactly as the rule it replaces does. Same population, measured and shipped. |
| pushed into `autoFlat`, blocking LONG on its best bars | stays in `autoFlat` **only because it REPLACES an existing autoFlat rule of identical scope** — this re-expresses one gate, it does not add one |
| no `isCryptoSym` guard → 24-symbol measurement gated 159 stocks | the cut is computed **per market**, from that market's own live distribution |
| never reached the notify precheck → zero-drift property destroyed | computed inside `evaluateEnvelope`, which the precheck reaches through `buildUserPrompt`. One implementation, no second path. |
| reason prefix changed → `isQualityGateReason` stopped matching, killing the FRAMING hatch | the reason string **keeps its `ML_WIN_` prefix**, asserted by a test |

## Pre-declared success criteria

This is a **restoration**, not a new edge, so it is not judged on payoff. It succeeds if:

1. **Selectivity is restored.** The floor rejects 45% ± 5pp of live bars, against 8.0% today.
2. **It is drift-proof.** Simulating a base-rate shift of ±10pp moves the realised rejection rate by
   **< 5pp**, where the current level-based gate moves by tens of pp. *This is the whole point — if
   it fails, the change is pointless even if it looks better today.*
3. **Nothing else moves.** `< 60` and `< 70` remain level-based on the calibrated scale, and the
   FRAMING hatch still fires. Asserted by tests, not by inspection.
4. **It degrades safely.** With no live distribution (cold start, empty table) it falls back to the
   current `< 50` level rather than blocking everything or nothing.

## What this does NOT claim

It does **not** claim the app will make more money. Phase 2 could not show that a tighter ML floor
pays on both sides — it lifts SHORT and inverts LONG, and every arm sat in one window. What it claims
is narrower and checkable: **the gate will do what it was designed to do, and go on doing it when the
scale moves again.** Whether 45% is the right selectivity is a separate question this does not answer
and must not be tuned to.

## Rollback

One constant. Setting `COVERAGE_FLOOR = null` restores the level-based gate exactly.

---

# RESULT (2026-08-26) — all four criteria met

## Criterion 2 is the one that mattered, and the margin is not subtle

Fraction of bars the floor rejects, as the prediction distribution's centre shifts:

| distribution centre | LEVEL (`calibrated < 50`) | COVERAGE (fixed 0.45) |
|---|---:|---:|
| 0.40 | **70.1%** | 42.6% |
| 0.45 | 57.0% | 42.8% |
| 0.50 | 42.9% | 42.9% |
| 0.55 | 29.7% | 43.0% |
| 0.60 | **18.9%** | 43.2% |

**The level gate swings across 51 points of selectivity. The coverage gate moves 0.6.**

That is the failure, reproduced: a ±10pp shift in the live base rate is enough to turn a gate that
rejects 70% of bars into one that rejects 19%, without anyone changing a line. It is exactly what
happened between v14's 50.5% training base and today's ~58% live base, and it is why a bar showing
raw 30 was producing setups.

## The other three

**1 — selectivity restored.** The cut rejects 42.9% against a declared 45% ± 5pp, and holds at 0.20 /
0.30 / 0.60 / 0.75 as well — it inverts a CDF rather than hitting one number.

**3 — nothing else moves.** The `< 60` and `< 70` tiers stay level-based on the calibrated scale; the
reason string keeps its `ML_WIN_` prefix so `isQualityGateReason` still matches and the FRAMING hatch
still fires; and the gate applies to BOTH sides, so the population it is measured on is the
population it ships against.

**4 — degrades safely.** Too little data returns null and the level gate is used unchanged. Verified
both directions: a null cut still FLATs at calibrated 40 and still passes at calibrated 55.

## What is now true of the user's case

A BTC bar at raw 30 sits below the live floor and **auto-FLATs**. Before this change it calibrated to
~50, cleared the floor, and produced a LOW-conviction setup.

## What this still does not claim

Nothing about profitability. Phase 2 could not show a tighter ML floor pays on both sides — it lifts
SHORT and inverts LONG, and every arm sat in one window. **Whether 45% is the right selectivity is
unanswered, and this must not be tuned toward an answer**: C6 measured that walk-forward fitting of
this threshold destroys it. What is established is narrower: the gate now does what it was designed
to do, and will go on doing it when the scale moves again.
