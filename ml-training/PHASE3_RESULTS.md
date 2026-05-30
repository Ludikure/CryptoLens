# Phase 3 Results — LLM layer (self-consistency / agreement)

The LLM-specific pieces (multi-sample directional thesis, adversarial critic) can
only be validated **live** (A/B via OutcomeTracker) — they change app behavior and
cost API calls, so they're designed here, not shipped blind. What IS offline-
validatable is their premise: does requiring independent direction signals to
*agree* add precision? Validated on the frozen holdout, crypto.

## Offline finding — agreement = a priority tier (not a primary gate)
On top of the Phase 2 conformal-confident set (win 73.4%, +0.754R):

| added filter | win% | EV/trade | volume kept |
|---|---|---|---|
| + bias & dStoch agree | 78.7% | **+0.886R** | 12% |
| + dStoch & hStoch agree (MTF) | 78.5% | +0.840R | 7% |
| + triple agree (bias+dStoch+dMacd) | 76.5% | +0.855R | 0.4% (n=51, too sparse) |

Agreement adds **+0.13R/trade and ~+5pp win-rate** — genuinely incremental over the
meta head (not redundant) — but at ~88% volume cost. So it belongs as a **high-
conviction "priority alert" tier** layered on the conformal gate, not as the main
filter. The triple-agree "priority tier" the docs reserved is real but too sparse
to act on at this horizon.

## LLM productionization design (requires live A/B to validate)
1. **Self-consistency.** Run the directional thesis N×, or Claude + Gemini, and
   gate conviction on agreement: full agreement -> permit HIGH; split -> cap
   MODERATE. Plumbing exists (provider abstraction, A/B TaskLocal). Mirror the
   offline finding: surface a "priority/high-conviction" badge when the independent
   technical signals (bias+dStoch / MTF stoch) also agree.
2. **Adversarial critic pass.** A second LLM call that tries to INVALIDATE the
   proposed setup (name the failure mode); suppress/downgrade on a hard failure.
   Gate by conviction (run only on HIGH candidates) to bound cost/latency.
3. **Richer outcome feedback.** Feed per-archetype × per-regime realized hit-rates
   into the prompt (OutcomeTracker already stores outcomes; extend the aggregation).

Validation: ship behind the existing A/B bucket; compare resolved-R distributions
baseline vs treatment in OutcomeDashboard. This is the only honest way to confirm
the LLM pieces help — do NOT ship them as default without that comparison.

## Ship decision
- **Offline-proven:** add an agreement-based **priority-conviction tier** (bias &
  dStoch agree, or MTF stoch agree) on top of the conformal crypto gate. Cheap,
  no LLM cost, +0.13R/trade on the tier.
- **LLM self-consistency + critic:** implement behind A/B; validate live before
  default-on. Designed, not auto-shipped.

Scripts: phase3_agreement.py. Results in phase_results.json.
