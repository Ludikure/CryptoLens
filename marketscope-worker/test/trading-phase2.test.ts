import { describe, it, expect } from 'vitest';
import {
  validate, probabilityOfReaching, expectedValueOfTarget, bestTargetR,
  randomWalkCurve, edgeOverRandomWalk, PayoffValidationError, type ExcursionCurve,
} from '../src/trading/payoff';
import {
  fitIsotonic, applyCalibration, splitForCalibration, reliability, brierScore, logLoss,
  CalibrationError, type FitSample,
} from '../src/trading/calibration';
import { LookaheadError } from '../src/trading/provenance';
import { generateCandidate, DEFAULT_STRUCTURE, defaultStructureR } from '../src/trading/generator';
import type { Provenance } from '../src/trading/candidate';
import type { PortfolioState } from '../src/trading/sizing';

const t = Date.parse('2026-08-24T12:00:00Z');
const prov = (o: Partial<Provenance> = {}): Provenance => ({
  dataTimestamp: t, featureTimestamp: t, decisionTimestamp: t,
  modelVersion: 'm1', crashModelVersion: 'c1', sizingConfigId: 's1', ...o,
});
const curve = (pts: Array<[number, number]>): ExcursionCurve =>
  ({ horizonHours: 72, points: pts.map(([atR, probability]) => ({ atR, probability })) });

describe('excursion curves', () => {
  it('rejects a non-monotone curve — reaching 5R implies reaching 3R', () => {
    expect(() => validate(curve([[1, 0.4], [3, 0.5]]))).toThrow(PayoffValidationError);
    expect(() => validate(curve([[1, 0.5], [3, 0.3], [5, 0.2]]))).not.toThrow();
  });

  it('rejects probabilities outside [0,1] and non-ascending R', () => {
    expect(() => validate(curve([[1, 1.2]]))).toThrow(/outside/);
    expect(() => validate(curve([[3, 0.5], [1, 0.4]]))).toThrow(/ascend/);
  });

  it('interpolates between breakpoints', () => {
    const c = curve([[1, 0.60], [5, 0.20]]);
    expect(probabilityOfReaching(c, 3)).toBeCloseTo(0.40, 10);
    expect(probabilityOfReaching(c, 0.5)).toBeCloseTo(0.60, 10);   // clamps below
    expect(probabilityOfReaching(c, 9)).toBeCloseTo(0.20, 10);     // clamps above
  });
});

describe('random-walk baseline — the control a payoff model must beat', () => {
  it('gives 1/(1+R), so 5R is 16.7%', () => {
    const rw = randomWalkCurve(72);
    expect(probabilityOfReaching(rw, 5)).toBeCloseTo(1 / 6, 10);
    expect(probabilityOfReaching(rw, 1)).toBeCloseTo(0.5, 10);
  });

  it('is a FAIR bet at every multiple — zero expected value', () => {
    const rw = randomWalkCurve(72);
    for (const r of [1, 2, 3, 5, 8]) expect(expectedValueOfTarget(rw, r)).toBeCloseTo(0, 9);
  });

  it('isolates the fat-tail edge: ~30% at 5R vs 16.7% theory', () => {
    const measured = curve([[1, 0.62], [3, 0.40], [5, 0.30]]);
    expect(edgeOverRandomWalk(measured, 5)).toBeCloseTo(0.30 - 1 / 6, 6);
    expect(expectedValueOfTarget(measured, 5)).toBeGreaterThan(0);
  });
});

describe('expected value of a target', () => {
  it('treats anything short of the target as a full -1R — conservative by design', () => {
    const c = curve([[5, 0.30]]);
    expect(expectedValueOfTarget(c, 5)).toBeCloseTo(0.30 * 5 - 0.70, 10);
  });

  it('bestTargetR is RESEARCH-only; T4 showed dynamic selection loses in production', () => {
    const c = curve([[1, 0.62], [3, 0.40], [5, 0.30], [8, 0.20]]);
    const best = bestTargetR(c, [1, 3, 5, 8]);
    expect([1, 3, 5, 8]).toContain(best.targetR);
    expect(best.evR).toBeGreaterThanOrEqual(expectedValueOfTarget(c, 5));
  });
});

describe('calibration (spec §13)', () => {
  const mk = (n: number, raw: number, rate: number, base = t - 86_400_000): FitSample[] =>
    Array.from({ length: n }, (_, i) => ({
      rawScore: raw, outcome: (i / n < rate ? 1 : 0) as 0 | 1, timestamp: base + i,
    }));

  it('fits a monotone curve and maps raw scores onto realised rates', () => {
    const s = [...mk(100, 0.15, 0.20), ...mk(100, 0.45, 0.45), ...mk(100, 0.75, 0.70)];
    const cal = fitIsotonic(s, { id: 'c' });
    expect(cal.points.length).toBeGreaterThanOrEqual(3);
    expect(applyCalibration(cal, 0.15, t)).toBeLessThan(applyCalibration(cal, 0.75, t));
  });

  it('POOLS adjacent violators so the output is never non-monotone', () => {
    // a middle bucket that realises LOWER than the one below it must be pooled away
    const s = [...mk(100, 0.15, 0.20), ...mk(100, 0.45, 0.10), ...mk(100, 0.75, 0.70)];
    const cal = fitIsotonic(s, { id: 'c' });
    for (let i = 1; i < cal.points.length; i++) {
      expect(cal.points[i].calibrated).toBeGreaterThanOrEqual(cal.points[i - 1].calibrated - 1e-12);
    }
  });

  it('REFUSES to apply a calibrator fit on data at or after the application time', () => {
    const cal = fitIsotonic([...mk(100, 0.2, 0.2, t + 1000), ...mk(100, 0.8, 0.8, t + 1000)], { id: 'future' });
    expect(() => applyCalibration(cal, 0.5, t)).toThrow(LookaheadError);
  });

  it('drops sparse buckets rather than fitting a step to a handful of points', () => {
    const s = [...mk(100, 0.2, 0.2), ...mk(5, 0.5, 1.0), ...mk(100, 0.8, 0.8)];
    const cal = fitIsotonic(s, { id: 'c', minBucketN: 40 });
    expect(cal.points.every(p => p.n >= 40)).toBe(true);
  });

  it('errors rather than silently fitting too few buckets', () => {
    expect(() => fitIsotonic(mk(100, 0.5, 0.5), { id: 'c' })).toThrow(CalibrationError);
    expect(() => fitIsotonic([], { id: 'c' })).toThrow(/zero samples/);
  });

  it('honours floor and cap', () => {
    const s = [...mk(100, 0.05, 0.02), ...mk(100, 0.95, 0.99)];
    const cal = fitIsotonic(s, { id: 'c', floor: 0.10, cap: 0.85 });
    expect(applyCalibration(cal, 0.01, t)).toBeGreaterThanOrEqual(0.10);
    expect(applyCalibration(cal, 0.99, t)).toBeLessThanOrEqual(0.85);
  });

  it('splits with a purge that covers the label horizon', () => {
    const s: FitSample[] = Array.from({ length: 100 }, (_, i) => ({ rawScore: 0.5, outcome: 0, timestamp: i * 1000 }));
    const { fit, apply } = splitForCalibration(s, 50_000, 10_000);
    expect(Math.max(...fit.map(x => x.timestamp))).toBeLessThan(40_000);
    expect(Math.min(...apply.map(x => x.timestamp))).toBeGreaterThanOrEqual(50_000);
  });

  it('reports reliability, Brier and log loss', () => {
    const preds = [
      { probability: 0.1, outcome: 0 as const }, { probability: 0.1, outcome: 0 as const },
      { probability: 0.9, outcome: 1 as const }, { probability: 0.9, outcome: 1 as const },
    ];
    expect(brierScore(preds)).toBeCloseTo(0.01, 10);
    expect(logLoss(preds)).toBeLessThan(0.2);
    expect(reliability(preds).length).toBeGreaterThan(0);
  });
});

describe('candidate generation (spec §15)', () => {
  const portfolio: PortfolioState = { equity: 25000, openNotionalByAsset: {}, correlations: {} };
  const base = {
    asset: 'SOLUSDT', price: 100, atr: 4, sigma: 0.03, liquidityUsd24h: 50_000_000,
    crashRisk: { probability: 0.10, regime: 'LOW' as const, confidence: 0.8, horizonDays: 10 },
    portfolio, provenance: prov(),
  };
  const edge = curve([[1, 0.62], [3, 0.40], [5, 0.30], [8, 0.20]]);
  const weak = curve([[1, 0.50], [3, 0.25], [5, 0.16], [8, 0.10]]);

  it('generates a LONG when the long side has the edge', () => {
    const r = generateCandidate({ ...base, curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.7, SHORT: 0.4 } });
    expect(r.candidate.direction).toBe('LONG');
    expect(r.candidate.recommendedPositionFraction).toBeGreaterThan(0);
    expect(r.candidate.payoff.payoffAsymmetry).toBeCloseTo(5, 6);
  });

  it('returns NO TRADE when neither side clears — the system must do nothing comfortably', () => {
    const r = generateCandidate({ ...base, curves: { LONG: weak, SHORT: weak }, confidence: { LONG: 0.5, SHORT: 0.5 } });
    expect(r.candidate.recommendedPositionFraction).toBe(0);
    expect(r.rejectionReasons.join(' ')).toMatch(/expected value|no material edge/);
  });

  it('TRADES a direction-agnostic structure and flags it — the validated convex case', () => {
    // Both sides positive-EV with no edge either way. Refusing this would discard the one edge the
    // project validated: the convex structure is explicitly direction-agnostic (+0.151R gross).
    const r = generateCandidate({ ...base, curves: { LONG: edge, SHORT: edge }, confidence: { LONG: 0.6, SHORT: 0.6 } });
    expect(r.candidate.recommendedPositionFraction).toBeGreaterThan(0);
    expect(r.directionAgnostic).toBe(true);
    expect(r.rejectionReasons.join(' ')).toMatch(/no directional edge/);
    expect(r.considered.long).not.toBeNull();
    expect(r.considered.short).not.toBeNull();
  });

  it('does NOT flag direction-agnostic when one side genuinely has the edge', () => {
    const r = generateCandidate({ ...base, curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.7, SHORT: 0.4 } });
    expect(r.directionAgnostic).toBe(false);
    expect(r.candidate.direction).toBe('LONG');
  });

  it('rejects a stop sitting inside the noise band', () => {
    // a 0.3% stop against 3% horizon vol: volatility alone reaches it almost surely
    const r = generateCandidate({ ...base, atr: 0.3, sigma: 0.03, curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.7, SHORT: 0.4 } });
    expect(r.rejectionReasons.join(' ')).toMatch(/noise band/);
    expect(r.candidate.recommendedPositionFraction).toBe(0);
  });

  it('extreme crash risk closes the trade even with a strong edge', () => {
    const r = generateCandidate({
      ...base, curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.9, SHORT: 0.3 },
      crashRisk: { probability: 0.85, regime: 'EXTREME', confidence: 0.9, horizonDays: 10 },
    });
    expect(r.candidate.recommendedPositionFraction).toBe(0);
  });

  it('refuses to run on a lookahead provenance', () => {
    expect(() => generateCandidate({
      ...base, provenance: prov({ featureTimestamp: t + 1 }),
      curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.7, SHORT: 0.4 },
    })).toThrow(LookaheadError);
  });

  it('records the full config chain in provenance', () => {
    const r = generateCandidate({ ...base, curves: { LONG: edge, SHORT: weak }, confidence: { LONG: 0.7, SHORT: 0.4 } });
    expect(r.candidate.provenance.sizingConfigId).toMatch(/convex-1r5r-72h/);
    expect(r.candidate.provenance.sizingConfigId).toMatch(/placeholder-2026-08-24/);
    expect(r.candidate.provenance.sizingConfigId).toMatch(/default-2026-08-24/);
  });

  it('the default structure is the validated 1R/5R convex trade', () => {
    expect(DEFAULT_STRUCTURE.targetR).toBe(5);
    expect(DEFAULT_STRUCTURE.stopAtrMultiple).toBe(1);
    expect(DEFAULT_STRUCTURE.holdingHorizonHours).toBe(72);
    expect(defaultStructureR()).toBeCloseTo(5, 10);
  });

  it('uses the measured Coinbase Advanced 2 round trip, not a guess', () => {
    expect(DEFAULT_STRUCTURE.roundTripPercent).toBeCloseTo(0.171, 6);
  });
});
