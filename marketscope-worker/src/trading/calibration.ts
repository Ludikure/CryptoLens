/**
 * Training-safe probability calibration (spec §13).
 *
 * T18 found that the ML model's contribution is substantially CALIBRATION rather than
 * discrimination: realised volatility alone reaches AUC 0.612 against the model's 0.634, yet a raw
 * volatility percentile pushed through a fixed threshold produces a badly-timed exposure schedule
 * while the model's calibrated probability does not. Calibration is doing real work, so it deserves
 * to be a first-class, leak-guarded component rather than a post-processing step.
 *
 * The rule this module exists to enforce: **a calibrator may only ever be fit on data that predates
 * what it is applied to.** Fitting on the test period is the most flattering mistake available — it
 * produces a perfect reliability curve that means nothing.
 */

import { assertBackwardOnly } from './provenance';

export class CalibrationError extends Error {
  constructor(m: string) { super(m); this.name = 'CalibrationError'; }
}

export interface CalibrationPoint { rawScore: number; calibrated: number; n: number }

export interface Calibrator {
  readonly id: string;
  readonly method: 'isotonic' | 'platt';
  /** Last timestamp in the fitting data. Enforces the backward-only rule at apply time. */
  readonly fitThroughTimestamp: number;
  readonly points: ReadonlyArray<CalibrationPoint>;
  readonly floor: number;
  readonly cap: number;
}

/** One observation used for fitting. */
export interface FitSample { rawScore: number; outcome: 0 | 1; timestamp: number }

/**
 * Pool-adjacent-violators isotonic fit.
 *
 * Isotonic rather than Platt by default because the relationship between score and realised rate has
 * repeatedly been monotone-but-not-sigmoid here (see the 2026-08-21 live recalibration, where
 * predicted 25→77 realised 41→69 — compressed, monotone, and badly served by a logistic curve).
 *
 * `minBucketN` guards the tail: with sparse buckets PAV happily fits a step to three observations,
 * and that step then governs every future prediction landing in it.
 */
export function fitIsotonic(
  samples: readonly FitSample[],
  opts: { id: string; bucketWidth?: number; minBucketN?: number; floor?: number; cap?: number } = { id: 'iso' },
): Calibrator {
  const bucketWidth = opts.bucketWidth ?? 0.05;
  const minBucketN = opts.minBucketN ?? 40;
  if (samples.length === 0) throw new CalibrationError('cannot fit a calibrator on zero samples');

  const buckets = new Map<number, { sum: number; n: number }>();
  let fitThrough = -Infinity;
  for (const s of samples) {
    if (s.rawScore < 0 || s.rawScore > 1) throw new CalibrationError(`raw score ${s.rawScore} outside [0,1]`);
    fitThrough = Math.max(fitThrough, s.timestamp);
    const k = Math.floor(s.rawScore / bucketWidth);
    const b = buckets.get(k) ?? { sum: 0, n: 0 };
    b.sum += s.outcome; b.n += 1; buckets.set(k, b);
  }

  const raw = [...buckets.entries()]
    .filter(([, b]) => b.n >= minBucketN)
    .map(([k, b]) => ({ rawScore: (k + 0.5) * bucketWidth, calibrated: b.sum / b.n, n: b.n }))
    .sort((a, b) => a.rawScore - b.rawScore);

  if (raw.length < 2) throw new CalibrationError(`only ${raw.length} bucket(s) cleared minBucketN=${minBucketN}`);

  // PAV: enforce monotonicity by pooling adjacent violators, weighted by bucket size.
  const stack: CalibrationPoint[] = [];
  for (const p of raw) {
    let cur = { ...p };
    while (stack.length && stack[stack.length - 1].calibrated > cur.calibrated) {
      const prev = stack.pop()!;
      const n = prev.n + cur.n;
      cur = {
        rawScore: prev.rawScore,
        calibrated: (prev.calibrated * prev.n + cur.calibrated * cur.n) / n,
        n,
      };
    }
    stack.push(cur);
  }

  return {
    id: opts.id,
    method: 'isotonic',
    fitThroughTimestamp: fitThrough,
    points: stack,
    floor: opts.floor ?? 0,
    cap: opts.cap ?? 1,
  };
}

/**
 * Apply a calibrator, refusing to run if it was fit on data at or after the application time.
 *
 * This is the guard, and it throws rather than warning. A silently mis-applied calibrator produces
 * plausible numbers, which is exactly what makes it dangerous.
 */
export function applyCalibration(cal: Calibrator, rawScore: number, appliedAtTimestamp: number): number {
  assertBackwardOnly(cal.fitThroughTimestamp, appliedAtTimestamp, `calibrator ${cal.id}`);
  const pts = cal.points;
  let out: number;
  if (rawScore <= pts[0].rawScore) out = pts[0].calibrated;
  else if (rawScore >= pts[pts.length - 1].rawScore) out = pts[pts.length - 1].calibrated;
  else {
    out = pts[pts.length - 1].calibrated;
    for (let i = 1; i < pts.length; i++) {
      if (rawScore <= pts[i].rawScore) {
        const a = pts[i - 1], b = pts[i];
        const w = (rawScore - a.rawScore) / (b.rawScore - a.rawScore);
        out = a.calibrated + w * (b.calibrated - a.calibrated);
        break;
      }
    }
  }
  return Math.min(Math.max(out, cal.floor), cal.cap);
}

/**
 * Split samples into a fitting set and an application set at a cut timestamp.
 *
 * Provided so callers do not hand-roll the split — the T2 purge defect (a 48-bar purge under a
 * 60-bar label horizon) came from exactly this kind of boundary being managed ad hoc. `purgeMs`
 * must cover the full label horizon.
 */
export function splitForCalibration(
  samples: readonly FitSample[],
  cutTimestamp: number,
  purgeMs: number,
): { fit: FitSample[]; apply: FitSample[] } {
  if (purgeMs < 0) throw new CalibrationError('purge must be non-negative');
  return {
    fit: samples.filter(s => s.timestamp < cutTimestamp - purgeMs),
    apply: samples.filter(s => s.timestamp >= cutTimestamp),
  };
}

/** Reliability curve for reporting (spec §13). */
export function reliability(
  predictions: ReadonlyArray<{ probability: number; outcome: 0 | 1 }>,
  edges: readonly number[] = [0, 0.3, 0.5, 0.6, 0.7, 0.85, 1],
): Array<{ lo: number; hi: number; predicted: number; realized: number; n: number }> {
  const out: Array<{ lo: number; hi: number; n: number; predicted: number; realized: number }> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inB = predictions.filter(p => p.probability >= lo && p.probability < hi);
    if (inB.length === 0) continue;
    out.push({
      lo, hi, n: inB.length,
      predicted: inB.reduce((a, b) => a + b.probability, 0) / inB.length,
      realized: inB.reduce((a, b) => a + b.outcome, 0) / inB.length,
    });
  }
  return out;
}

export function brierScore(predictions: ReadonlyArray<{ probability: number; outcome: 0 | 1 }>): number {
  if (predictions.length === 0) return NaN;
  return predictions.reduce((a, p) => a + (p.probability - p.outcome) ** 2, 0) / predictions.length;
}

export function logLoss(predictions: ReadonlyArray<{ probability: number; outcome: 0 | 1 }>, eps = 1e-15): number {
  if (predictions.length === 0) return NaN;
  return -predictions.reduce((a, p) => {
    const q = Math.min(Math.max(p.probability, eps), 1 - eps);
    return a + (p.outcome ? Math.log(q) : Math.log(1 - q));
  }, 0) / predictions.length;
}
