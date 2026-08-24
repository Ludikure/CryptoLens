/**
 * Expected-payoff model (spec §3).
 *
 * The spec asks for the *empirical conditional payoff distribution* rather than a fixed 1:1
 * assumption. That instruction is the right one, and this project has the evidence for why:
 *
 *   - Random-walk theory says a 1R-stop / 5R-target structure should hit its target ~16.7% of the
 *     time (barriers at −1 and +5 give P = 1/(1+5)) and be a fair bet.
 *   - The tail-gated version measured ~30%. That gap — large moves arriving more often than a
 *     normal distribution allows — is the entire source of +0.151R gross.
 *
 * So the payoff model's real job is estimating **excursion probability**, not direction. Everything
 * else in the expected-value calculation is geometry.
 */

import type { Direction } from './candidate';

/**
 * A conditional payoff distribution: the probability that forward maximum favourable excursion
 * reaches each R multiple *before* the stop is touched.
 *
 * Must be monotone decreasing in `atR` — reaching 5R implies having reached 3R. `validate()` checks
 * this, because a non-monotone curve silently produces nonsense expected values.
 */
export interface ExcursionCurve {
  readonly horizonHours: number;
  /** Ascending R multiples with P(reach this R before stopping out). */
  readonly points: ReadonlyArray<{ atR: number; probability: number }>;
}

export interface PayoffModel {
  readonly version: string;
  /**
   * @param features feature vector, already timestamp-validated
   * @param asOf decision time; implementations must not consult anything after it
   * @param direction the side being evaluated — see the note below on symmetry
   */
  excursionCurve(features: Record<string, number>, asOf: number, direction: Direction): ExcursionCurve;
}

export class PayoffValidationError extends Error {
  constructor(m: string) { super(m); this.name = 'PayoffValidationError'; }
}

/** Rejects curves that cannot be probability distributions. */
export function validate(curve: ExcursionCurve): void {
  if (curve.points.length === 0) throw new PayoffValidationError('empty excursion curve');
  let prevR = -Infinity, prevP = Infinity;
  for (const { atR, probability } of curve.points) {
    if (atR <= prevR) throw new PayoffValidationError(`R multiples must strictly ascend (saw ${atR} after ${prevR})`);
    if (probability < 0 || probability > 1) throw new PayoffValidationError(`probability ${probability} outside [0,1]`);
    if (probability > prevP) {
      throw new PayoffValidationError(
        `probability must be non-increasing in R: P(${atR}R)=${probability} exceeds P(${prevR}R)=${prevP}`,
      );
    }
    prevR = atR; prevP = probability;
  }
}

/** P(reaching `targetR` before the stop), interpolated between breakpoints. */
export function probabilityOfReaching(curve: ExcursionCurve, targetR: number): number {
  validate(curve);
  const pts = curve.points;
  if (targetR <= pts[0].atR) return pts[0].probability;
  if (targetR >= pts[pts.length - 1].atR) return pts[pts.length - 1].probability;
  for (let i = 1; i < pts.length; i++) {
    if (targetR <= pts[i].atR) {
      const a = pts[i - 1], b = pts[i];
      const w = (targetR - a.atR) / (b.atR - a.atR);
      return a.probability + w * (b.probability - a.probability);
    }
  }
  return pts[pts.length - 1].probability;
}

/**
 * Expected value of a fixed-target structure, in R, from the excursion curve.
 *
 * Deliberately simple and deliberately conservative: anything that does not reach the target is
 * treated as a full −1R loss. Real outcomes include timeouts that exit between the barriers (T5
 * measured ~20% of trades timing out, which softens the loss side), so this UNDERSTATES expected
 * value. Understating is the right direction for a number that drives position sizing.
 */
export function expectedValueOfTarget(curve: ExcursionCurve, targetR: number): number {
  const p = probabilityOfReaching(curve, targetR);
  return p * targetR - (1 - p) * 1;
}

/**
 * The target R maximising expected value over a set of CANDIDATE multiples.
 *
 * ⚠️ Read this before using it in production. T4 tested per-bar dynamic target selection directly
 * and it LOST to a fixed 1:5 structure in every fold (+0.0911R dynamic vs +0.4261R fixed), because
 * predicted excursions regress to the mean and the model kept choosing tight targets — which the
 * same table showed were the worst option.
 *
 * So this function exists for RESEARCH — comparing structures across a corpus — and the production
 * generator uses a fixed multiple. Payoff structure should be fixed and wide, not predicted.
 */
export function bestTargetR(curve: ExcursionCurve, candidates: readonly number[]): { targetR: number; evR: number } {
  let best = { targetR: candidates[0] ?? 0, evR: -Infinity };
  for (const t of candidates) {
    const ev = expectedValueOfTarget(curve, t);
    if (ev > best.evR) best = { targetR: t, evR: ev };
  }
  return best;
}

/**
 * A driftless random-walk baseline: P(reach +bR before −1R) = 1/(1+b).
 *
 * This is the control every payoff model must beat. A model whose curve matches this has discovered
 * nothing — it has rederived the geometry. The ~30%-vs-16.7% gap at 5R is what a real fat-tailed
 * edge looks like.
 */
export function randomWalkCurve(horizonHours: number, rMultiples: readonly number[] = [1, 2, 3, 5, 8]): ExcursionCurve {
  return {
    horizonHours,
    points: rMultiples.map(r => ({ atR: r, probability: 1 / (1 + r) })),
  };
}

/** How much a curve exceeds the random-walk baseline at a given target — the edge, isolated. */
export function edgeOverRandomWalk(curve: ExcursionCurve, targetR: number): number {
  return probabilityOfReaching(curve, targetR) - 1 / (1 + targetR);
}
