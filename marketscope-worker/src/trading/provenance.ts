/**
 * Anti-lookahead enforcement (spec §20).
 *
 * This project has shipped lookahead twice, and both times it looked like a discovery first:
 *   - 2026-06-02: the in-progress daily candle leaked into intraday features and produced a 94.7%
 *     directional accuracy that was entirely artifact.
 *   - 2026-08-23: T10's persistence mask used the same day's close to set that day's exposure,
 *     inflating Calmar 1.43 → 2.75 and INVERTING the ranking of the arms.
 *
 * Both were found by accident. This module makes the invariant checkable instead — an assertion the
 * pipeline runs rather than a property anyone remembers to preserve.
 */

import type { Provenance } from './candidate';

export class LookaheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookaheadError';
  }
}

/**
 * The core invariant: nothing used to make a decision may postdate the decision.
 *
 * `toleranceMs` exists for one legitimate reason — a bar stamped at its OPEN whose features are
 * computed at its close would otherwise trip the check. It defaults to 0 so a caller must
 * deliberately opt into any slack, and the reason must be given.
 */
export function assertNoLookahead(p: Provenance, toleranceMs = 0, reason?: string): void {
  if (toleranceMs > 0 && !reason) {
    throw new LookaheadError('a non-zero lookahead tolerance requires an explicit reason');
  }
  if (p.featureTimestamp > p.decisionTimestamp + toleranceMs) {
    throw new LookaheadError(
      `feature timestamp ${new Date(p.featureTimestamp).toISOString()} postdates decision ` +
      `${new Date(p.decisionTimestamp).toISOString()} by ${p.featureTimestamp - p.decisionTimestamp}ms`,
    );
  }
  if (p.dataTimestamp > p.decisionTimestamp + toleranceMs) {
    throw new LookaheadError(
      `data timestamp ${new Date(p.dataTimestamp).toISOString()} postdates decision ` +
      `${new Date(p.decisionTimestamp).toISOString()}`,
    );
  }
}

/**
 * The label-horizon purge check (spec §21).
 *
 * T2 used a 48-bar purge against a 60-bar label horizon, so the last 12 bars of every training fold
 * carried labels extending into the test window. The effect was small (Calmar 1.50 → 1.47 once
 * corrected) but it was real, and it went unnoticed for the whole T8-T11 arc.
 *
 * The rule is not "use a purge" — it is "the purge must be at least the full label horizon."
 */
export function assertPurgeCoversHorizon(purgeBars: number, labelHorizonBars: number): void {
  if (purgeBars < labelHorizonBars) {
    throw new LookaheadError(
      `purge of ${purgeBars} bars is shorter than the ${labelHorizonBars}-bar label horizon: ` +
      `training labels would extend into the test window`,
    );
  }
}

/**
 * Guards against the subtler leak: a statistic computed over the FULL series and then applied
 * historically. Percentile thresholds, z-score means, calibration curves and normalisation
 * constants must all come from data available at the time.
 */
export function assertBackwardOnly(
  statisticEndTimestamp: number,
  appliedAtTimestamp: number,
  label: string,
): void {
  if (statisticEndTimestamp > appliedAtTimestamp) {
    throw new LookaheadError(
      `${label} was computed using data through ${new Date(statisticEndTimestamp).toISOString()} ` +
      `but applied at ${new Date(appliedAtTimestamp).toISOString()} — full-sample statistic leaking backwards`,
    );
  }
}

/** Non-throwing variant for batch validation, so a research run can report every violation at once. */
export function findLookaheadViolations(candidates: Array<{ provenance: Provenance; asset: string }>): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    try {
      assertNoLookahead(c.provenance);
    } catch (e) {
      out.push(`${c.asset}: ${(e as Error).message}`);
    }
  }
  return out;
}
