import { describe, it, expect } from 'vitest';
import { crashProbability, crashWarning, crashModelInfo, VALIDATED_CURVE } from '../src/trading/crash';
import { crashMultiplier, crashRegime, PLACEHOLDER_CURVE } from '../src/trading/crash-risk';

/** A live-shaped feature dict. Only shape matters; the scenarios vary the market-wide block. */
const feats = (o: Record<string, number> = {}) => {
  const b: Record<string, number> = {};
  for (const k of ['dRsi', 'dAdx', 'hRsi', 'atrPercent', 'atrPercentile', 'vix', 'dxyMomentum',
    'vixTermStructure', 'fearGreedIndex', 'ethBtcRatio', 'dayOfWeek', 'regimeCode', 'tfAlignment',
    'fundingRateRaw', 'oiChangePct', 'longPctRaw', 'dBBPercentB', 'dVolumeRatio']) b[k] = 1;
  return { ...b, ...o };
};

describe('crash model — the one signal that survived every control', () => {
  it('discriminates: different market states give different probabilities', () => {
    const calm = crashProbability(feats({ vix: 12, atrPercent: 1.0, fearGreedIndex: 78 }));
    const stressed = crashProbability(feats({ vix: 38, atrPercent: 6.0, fearGreedIndex: 9 }));
    expect(calm).not.toBeCloseTo(stressed, 4);
  });

  it('never exceeds the SUPPORTED ceiling, whatever it is fed', () => {
    // The same discipline as the excursion export: an isotonic tail resting on a few points must
    // not be able to cut position size to zero on thin evidence.
    for (const v of [0, -1e6, 1e6, 999]) {
      const p = crashProbability(feats({ vix: v, atrPercent: Math.abs(v) + 1, dRsi: v }));
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(0.62);
    }
  });

  it('ships the VALIDATED curve, not the placeholder', () => {
    expect(VALIDATED_CURVE.id).toMatch(/^crash-t8-arm-d/);
    expect(VALIDATED_CURVE.id).not.toBe(PLACEHOLDER_CURVE.id);
  });

  it('reproduces T8 arm D exactly: 1.00 below 0.30, 0.50 to 0.50, 0.00 above', () => {
    expect(crashMultiplier(0.10, VALIDATED_CURVE)).toBeCloseTo(1.0, 3);
    expect(crashMultiplier(0.29, VALIDATED_CURVE)).toBeCloseTo(1.0, 3);
    expect(crashMultiplier(0.40, VALIDATED_CURVE)).toBeCloseTo(0.5, 2);
    expect(crashMultiplier(0.60, VALIDATED_CURVE)).toBeCloseTo(0.0, 3);
  });

  it('has NO exposure floor — T15 measured that a floor removes the benefit', () => {
    expect(crashMultiplier(0.95, VALIDATED_CURVE)).toBe(0);
    expect(Math.min(...VALIDATED_CURVE.points.map(p => p.multiplier))).toBe(0);
  });

  it('warns above 0.30 and stays silent below, at the validated thresholds', () => {
    expect(crashWarning(0.20)).toBeNull();
    expect(crashWarning(0.40)?.level).toBe('ELEVATED');
    expect(crashWarning(0.60)?.level).toBe('HIGH');
  });

  it('states the EPISODIC caveat in every warning it emits', () => {
    // A user who sees this fire twice then sit quiet through a 25% fall would reasonably think it
    // broken. Absence of warning is a documented property, so every message must say so.
    for (const p of [0.40, 0.60]) {
      expect(crashWarning(p)!.message).toMatch(/episodic|Quiet is not/i);
    }
  });

  it('reports its real walk-forward AUC rather than implying certainty', () => {
    const i = crashModelInfo();
    expect(i.horizonDays).toBe(10);
    expect(i.walkForwardAuc.length).toBeGreaterThan(0);
    for (const a of i.walkForwardAuc) {
      expect(a).toBeGreaterThan(0.55);
      expect(a).toBeLessThan(0.70);
    }
  });

  it('regime labels track the curve', () => {
    expect(crashRegime(0.10, VALIDATED_CURVE)).toBe('LOW');
    expect(crashRegime(0.60, VALIDATED_CURVE)).toBe('EXTREME');
  });
});
