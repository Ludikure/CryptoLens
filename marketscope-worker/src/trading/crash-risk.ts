/**
 * Crash-risk model interface and the SIZING overlay (spec §5, §6, §7).
 *
 * The crash model answers ONE question: how likely is an extreme forward drawdown? It is not a
 * directional signal, and this module deliberately exposes no way to turn it into one — the only
 * output is a multiplier applied to a position an independent opportunity model already justified.
 *
 * WHAT THE RESEARCH CONSTRAINS HERE, and why each constraint is uncomfortable:
 *
 *   T9   the signal carries real anticipatory information (Calmar 1.74 vs 0.48), with 22-30 days
 *        of lead before regime-level crashes.
 *   T11  it is EPISODIC — absent through five 20-28% drawdowns in 2023-25. It does not protect
 *        against every decline and must not be described as if it does.
 *   T12  requiring volatility confirmation DESTROYED the benefit (2022 bear +28% → −70%), because
 *        the value IS the lead time. Do not add a confirmation filter to reduce false alarms.
 *   T13  applying it only to new capital made the benefit negligible (+2.5% over six years).
 *   T15  a 25% exposure floor fixed the 2021 problem and destroyed the 2022 protection.
 *
 * The through-line: **every attempt to make this signal cheaper removed the benefit in proportion.**
 * So this module does NOT soften the curve to reduce turnover. Turnover is the price, and the spec
 * (§6) is explicit that it must not be silently discounted.
 */

import { assertBackwardOnly } from './provenance';
import type { CrashRisk } from './candidate';

/** What any crash model must provide. Implementations are swappable; the contract is not. */
export interface CrashModel {
  readonly version: string;
  /** Label horizon in days — the window the probability actually refers to. */
  readonly horizonDays: number;
  /**
   * @param features feature vector, already timestamp-validated by the caller
   * @param asOf decision time; implementations must not consult anything after it
   */
  predict(features: Record<string, number>, asOf: number): CrashRisk;
}

/**
 * A sizing curve maps crash probability to a position multiplier.
 *
 * FROZEN BY CONSTRUCTION: every curve carries an `id` that must change when any number changes, and
 * that id is recorded in each candidate's provenance. A curve silently retuned against historical
 * results would otherwise be undetectable in the trade journal.
 */
export interface SizingCurve {
  readonly id: string;
  readonly description: string;
  /** Ascending probability breakpoints with the multiplier applied at or above each. */
  readonly points: ReadonlyArray<{ atProbability: number; multiplier: number; regime: CrashRisk['regime'] }>;
}

/**
 * The spec's initial specification (§6), carried verbatim and labelled as what it is.
 *
 * These numbers are PLACEHOLDERS. They were not fitted, and the spec is explicit that they must not
 * be silently adopted as a research result. Any successor curve must be pre-declared, frozen, and
 * evaluated out-of-sample before replacing this one.
 *
 * Note what is deliberately ABSENT: no exposure floor (T15 showed a floor destroys the protection)
 * and no volatility-confirmation gate (T12 showed confirmation destroys the lead time). Both were
 * tempting fixes for the high turnover and both are known to remove the benefit.
 */
export const PLACEHOLDER_CURVE: SizingCurve = {
  id: 'placeholder-2026-08-24',
  description: 'Spec §6 initial specification. NOT fitted, NOT validated — a starting point only.',
  points: [
    { atProbability: 0.00, multiplier: 1.00, regime: 'LOW' },
    { atProbability: 0.30, multiplier: 0.75, regime: 'ELEVATED' },
    { atProbability: 0.50, multiplier: 0.50, regime: 'HIGH' },
    { atProbability: 0.70, multiplier: 0.00, regime: 'EXTREME' },
  ],
};

/**
 * A curve that never reduces exposure. The control arm — any claimed benefit from crash sizing must
 * be measured against this, not against buy-and-hold.
 */
export const NEUTRAL_CURVE: SizingCurve = {
  id: 'neutral-control',
  description: 'Control: no crash adjustment. Every research comparison must include this arm.',
  points: [{ atProbability: 0.00, multiplier: 1.00, regime: 'LOW' }],
};

/** Step lookup — deliberately NOT interpolated, so the applied multiplier is always an exact curve value. */
export function crashMultiplier(probability: number, curve: SizingCurve = PLACEHOLDER_CURVE): number {
  let m = curve.points[0]?.multiplier ?? 1;
  for (const p of curve.points) {
    if (probability >= p.atProbability) m = p.multiplier;
    else break;
  }
  return m;
}

export function crashRegime(probability: number, curve: SizingCurve = PLACEHOLDER_CURVE): CrashRisk['regime'] {
  let r: CrashRisk['regime'] = curve.points[0]?.regime ?? 'LOW';
  for (const p of curve.points) {
    if (probability >= p.atProbability) r = p.regime;
    else break;
  }
  return r;
}

/**
 * Apply the overlay. The signature enforces spec §7 structurally: it takes a position that ALREADY
 * exists and can only scale it. There is no code path by which crash risk opens or reverses a trade.
 */
export function applyCrashOverlay(
  basePositionFraction: number,
  crash: CrashRisk,
  curve: SizingCurve = PLACEHOLDER_CURVE,
): { fraction: number; multiplier: number; curveId: string } {
  if (!(basePositionFraction > 0)) return { fraction: 0, multiplier: 1, curveId: curve.id };
  const multiplier = crashMultiplier(crash.probability, curve);
  return { fraction: basePositionFraction * multiplier, multiplier, curveId: curve.id };
}

/**
 * Guards the leak that T10 actually shipped: a crash estimate must not be derived from data at or
 * after the moment it is used to size. Call this wherever a probability enters the sizing path.
 */
export function assertCrashEstimateIsLagged(featureEndTimestamp: number, decisionTimestamp: number): void {
  assertBackwardOnly(featureEndTimestamp, decisionTimestamp, 'crash-risk estimate');
}
