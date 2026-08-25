// Live calibration refit (2026-08-21): PAV fit over the forward-graded ml_calibration
// buckets + piecewise-linear application. Regression context: the Aug 2026 live curve was
// compressed (predicted 25→77 realizing 41→69) with one small inversion; the fit must
// pool the inversion, interpolate honestly, and refuse to fit thin data.
import { describe, it, expect } from 'vitest';
import { fitCalibrationCurve, applyCalibration, coverageCut, ML_SHORT_GATE_COVERAGE, CAL_MIN_BUCKET_N, CAL_MIN_TOTAL_N, type CalBucket } from '../src/calibration';

// The live curve observed 2026-08-21 (mixed-market /ml-calibration, rates as 0-1).
const LIVE_AUG_2026: CalBucket[] = [
  { predMean: 0.2496, realized: 0.4120, n: 1170 },
  { predMean: 0.3939, realized: 0.5973, n: 3588 },
  { predMean: 0.5495, realized: 0.5870, n: 1644 },   // inversion vs previous — PAV must pool
  { predMean: 0.6406, realized: 0.6197, n: 823 },    // still below the 30-50 bucket
  { predMean: 0.7716, realized: 0.6859, n: 382 },
];

describe('fitCalibrationCurve', () => {
  it('produces a monotone nondecreasing curve, pooling the live inversion', () => {
    const curve = fitCalibrationCurve(LIVE_AUG_2026)!;
    expect(curve).not.toBeNull();
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].y).toBeGreaterThanOrEqual(curve[i - 1].y);
      expect(curve[i].x).toBeGreaterThan(curve[i - 1].x);
    }
    // The 39/55/64 buckets (59.7 / 58.7 / 62.0) violate monotonicity pairwise; the pooled
    // block's value must sit between the extremes and preserve total mass.
    const totalN = curve.reduce((s, p) => s + p.n, 0);
    expect(totalN).toBe(LIVE_AUG_2026.reduce((s, b) => s + b.n, 0));
  });

  it('drops buckets below CAL_MIN_BUCKET_N before fitting', () => {
    const clean = fitCalibrationCurve(LIVE_AUG_2026)!;
    const withNoise: CalBucket[] = [...LIVE_AUG_2026, { predMean: 0.9, realized: 0.1, n: CAL_MIN_BUCKET_N - 1 }];
    const curve = fitCalibrationCurve(withNoise)!;
    // Pinned EXACTLY, not "> 0.6": PAV would pool an unfiltered thin bucket into the top block and
    // return 0.6304 instead of 0.6859 — a loose bound passes both ways, making this a non-test of
    // the filter it names. The top y is load-bearing (it is the curve's ceiling, which the
    // unreachable-gate guard alarms on), so it gets an equality assertion.
    expect(curve).toEqual(clean);
    expect(applyCalibration(curve, 0.9)).toBeCloseTo(clean[clean.length - 1].y, 10);
    expect(curve[curve.length - 1].n).toBe(382);   // top block is the real 70-85 bucket, unpolluted
  });

  it('returns null on insufficient total samples (fallback to raw)', () => {
    const thin: CalBucket[] = [
      { predMean: 0.3, realized: 0.5, n: 100 },
      { predMean: 0.6, realized: 0.6, n: 100 },
    ];
    expect(100 + 100).toBeLessThan(CAL_MIN_TOTAL_N);
    expect(fitCalibrationCurve(thin)).toBeNull();
  });

  it('returns null with fewer than 2 usable buckets', () => {
    expect(fitCalibrationCurve([{ predMean: 0.5, realized: 0.6, n: 10_000 }])).toBeNull();
    expect(fitCalibrationCurve([])).toBeNull();
  });
});

describe('applyCalibration', () => {
  const curve = fitCalibrationCurve(LIVE_AUG_2026)!;

  it('lifts the BTC Aug-2026 case toward the live realized rate', () => {
    // With these COARSE 5 buckets, PAV pools the inverted 39/55 buckets into a centroid at
    // x=0.443, so raw 0.391 interpolates to ~0.545 — above the 35/65 blend's 0.529 but
    // conservative. Production fits 5pp fine buckets, where a raw 0.39 sits essentially on
    // its own bucket's centroid (~0.59 realized) instead of interpolating across a gap.
    const v = applyCalibration(curve, 0.391);
    expect(v).toBeGreaterThan(0.53);
    expect(v).toBeLessThan(0.60);
    // Fine-bucket shape (flat ~59-60% across 30-50, as the live coarse bucket implies):
    const fine = fitCalibrationCurve([
      { predMean: 0.275, realized: 0.44, n: 400 },
      { predMean: 0.325, realized: 0.55, n: 800 },
      { predMean: 0.375, realized: 0.59, n: 1200 },
      { predMean: 0.425, realized: 0.60, n: 1100 },
      { predMean: 0.475, realized: 0.60, n: 700 },
    ])!;
    expect(applyCalibration(fine, 0.391)).toBeGreaterThan(0.58);
  });

  it('clamps below the fitted range to the bottom realized rate', () => {
    expect(applyCalibration(curve, 0.05)).toBeCloseTo(curve[0].y, 10);
  });

  it('clamps above the fitted range to the top realized rate (no extrapolated confidence)', () => {
    const top = curve[curve.length - 1].y;
    expect(applyCalibration(curve, 0.85)).toBeCloseTo(top, 10);
    // The honest ceiling: the live top bucket realizes ~69%, so nothing maps above it.
    expect(top).toBeLessThan(0.70);
  });

  it('interpolates linearly between fitted points', () => {
    const simple = [
      { x: 0.2, y: 0.4, n: 500 },
      { x: 0.6, y: 0.6, n: 500 },
    ];
    expect(applyCalibration(simple, 0.4)).toBeCloseTo(0.5, 10);
    expect(applyCalibration(simple, 0.3)).toBeCloseTo(0.45, 10);
  });

  it('is monotone in raw across the whole domain', () => {
    let prev = -1;
    for (let raw = 0; raw <= 1.0001; raw += 0.01) {
      const v = applyCalibration(curve, raw);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('returns raw unchanged on an empty curve', () => {
    expect(applyCalibration([], 0.42)).toBe(0.42);
  });
});

// Part 11: the ML gate as SELECTIVITY. A fixed ML>=0.55 beats no-gate on SHORT by +0.0257R at 7/8
// periods with 41.3% coverage; on LONG every threshold is negative. It is stored as coverage
// because an absolute number does not survive a base-rate shift — 0.55 admits 41.3% of backtest
// bars and only 36.3% of live ones.
describe('coverageCut — the ML gate expressed as selectivity', () => {
  // The live 2026-08-25 crypto distribution, as fetchLiveCalBuckets returns it.
  const live: CalBucket[] = [
    { predMean: 0.15, realized: 0.416, n: 1138 },
    { predMean: 0.40, realized: 0.603, n: 3459 },
    { predMean: 0.55, realized: 0.597, n: 1565 },
    { predMean: 0.65, realized: 0.663, n: 706 },
    { predMean: 0.775, realized: 0.714, n: 346 },
  ];

  it('returns a cut inside the distribution for the shipped coverage', () => {
    const cut = coverageCut(live, ML_SHORT_GATE_COVERAGE)!;
    expect(cut).toBeGreaterThan(0.4);
    expect(cut).toBeLessThan(0.6);
  });

  it('is monotone — asking for MORE coverage returns a LOWER cut', () => {
    const tight = coverageCut(live, 0.10)!, loose = coverageCut(live, 0.80)!;
    expect(tight).toBeGreaterThan(coverageCut(live, 0.41)!);
    expect(coverageCut(live, 0.41)!).toBeGreaterThan(loose);
  });

  it('the coverage is FIXED at the measured value and never re-optimised', () => {
    // Part 11's walk-forward arms showed fitting this parameter destroys it: argmax selection
    // chased slices admitting 0.2-4.5% of bars, one returning -0.53R out of sample.
    expect(ML_SHORT_GATE_COVERAGE).toBe(0.41);
  });

  it('refuses to produce a cut from too little data rather than guessing', () => {
    expect(coverageCut([{ predMean: 0.5, realized: 0.5, n: 10 }], 0.41)).toBeNull();
    expect(coverageCut([], 0.41)).toBeNull();
  });

  it('rejects degenerate coverage values', () => {
    expect(coverageCut(live, 0)).toBeNull();
    expect(coverageCut(live, 1)).toBeNull();
  });
});
