import { describe, it, expect } from 'vitest';
import { coverageCut, applyCalibration, fitCalibrationCurve, type CalBucket } from '../src/calibration';
import { evaluateEnvelope, type EnvelopeInput } from '../src/envelope';

// Pre-declared in docs/research/ml-floor-coverage.md, BEFORE any number here was computed.
//
// The envelope's hard floor was built to reject ~45% of bars and had come to reject 8.0%. Nothing
// decided that: the PAV layer correctly refits from live outcomes, but a cutoff written as a fixed
// LEVEL drifts in meaning as the SCALE moves under it — calibrated 50 now means raw 30.3%.
//
// Criterion 2 is the load-bearing one. If the coverage form is not measurably MORE drift-resistant
// than the level form, the change is pointless even if it looks better today.

/** A live prediction histogram shaped like the real one: unimodal, centred near the base rate. */
function distribution(centre: number, n = 200): CalBucket[] {
  const out: CalBucket[] = [];
  for (let i = 1; i <= 19; i++) {
    const x = i / 20;
    const w = Math.exp(-((x - centre) ** 2) / (2 * 0.14 ** 2));
    out.push({ predMean: x, realized: Math.min(0.95, x * 1.1), n: Math.round(n * w) + 1 });
  }
  return out;
}

/** Fraction of that distribution sitting below a raw cut. */
function rejectedAtRaw(buckets: CalBucket[], cut: number): number {
  const tot = buckets.reduce((s, b) => s + b.n, 0);
  return buckets.filter(b => b.predMean < cut).reduce((s, b) => s + b.n, 0) / tot;
}

/** Fraction rejected by the LEVEL gate: calibrated < 50, i.e. raw below the curve's 0.50 preimage. */
function rejectedAtLevel(buckets: CalBucket[]): number {
  const curve = fitCalibrationCurve(buckets);
  if (!curve) return NaN;
  const tot = buckets.reduce((s, b) => s + b.n, 0);
  return buckets.filter(b => applyCalibration(curve, b.predMean) < 0.50)
                .reduce((s, b) => s + b.n, 0) / tot;
}

describe('criterion 1 — selectivity is restored', () => {
  it('rejects the declared fraction, within 5pp', () => {
    const d = distribution(0.50);
    const cut = coverageCut(d, 0.45)!;
    expect(cut).not.toBeNull();
    expect(Math.abs(rejectedAtRaw(d, cut) - 0.45)).toBeLessThan(0.05);
  });

  it('holds at other coverages too — it is inverting a CDF, not hitting one number', () => {
    const d = distribution(0.50);
    for (const cov of [0.20, 0.30, 0.60, 0.75]) {
      expect(Math.abs(rejectedAtRaw(d, coverageCut(d, cov)!) - cov)).toBeLessThan(0.05);
    }
  });
});

describe('criterion 2 — DRIFT RESISTANCE, the reason for the change', () => {
  it('a +-10pp shift in the distribution moves coverage rejection by < 5pp', () => {
    const base = coverageCut(distribution(0.50), 0.45)!;
    for (const centre of [0.40, 0.60]) {
      const shifted = distribution(centre);
      // Re-derived from the shifted distribution, which is the whole point.
      const moved = rejectedAtRaw(shifted, coverageCut(shifted, 0.45)!);
      expect(Math.abs(moved - 0.45), `centre ${centre}`).toBeLessThan(0.05);
    }
    expect(base).toBeGreaterThan(0);
  });

  it('the LEVEL gate moves far more under the same shift — the defect, quantified', () => {
    // Without this the test above proves nothing: a gate could be stable and still be no better
    // than what it replaced.
    const spread = [0.40, 0.50, 0.60].map(c => rejectedAtLevel(distribution(c)));
    const levelRange = Math.max(...spread) - Math.min(...spread);
    const covRange = Math.max(...[0.40, 0.50, 0.60].map(c => {
      const d = distribution(c);
      return rejectedAtRaw(d, coverageCut(d, 0.45)!);
    })) - Math.min(...[0.40, 0.50, 0.60].map(c => {
      const d = distribution(c);
      return rejectedAtRaw(d, coverageCut(d, 0.45)!);
    }));
    expect(covRange).toBeLessThan(levelRange);
    expect(levelRange).toBeGreaterThan(0.10);
  });
});

describe('criterion 4 — it degrades safely', () => {
  it('returns null on too little data rather than a fabricated cut', () => {
    expect(coverageCut([], 0.45)).toBeNull();
    expect(coverageCut([{ predMean: 0.5, realized: 0.5, n: 10 }], 0.45)).toBeNull();
  });

  it('a null cut falls back to the LEVEL gate, not to blocking everything or nothing', () => {
    const base: EnvelopeInput = {
      rawMlWin: 0.30, calibratedMlWin: 0.40, staleCount: 0, anyKilled: false, macroRisk: 'NONE',
      newsConflicts: false, alignment: 'ALIGNED_BULLISH', alignedDirection: 'LONG',
      continuationCount: 3, isCrypto: true, isStock: false, isTreatment: true, regime: 'TRENDING',
      longConfirmStatus: 'n/a', oneHOpposes: false, cryptoBearRegime: false, daysToEarnings: null,
      mlCoverageCut: null,
    };
    // calibrated 40 < 50 -> the level gate still flats.
    expect(evaluateEnvelope(base).autoFlat.some(r => r.startsWith('ML_WIN_'))).toBe(true);
    // calibrated 55 -> no ML flat.
    expect(evaluateEnvelope({ ...base, calibratedMlWin: 0.55 }).autoFlat
      .some(r => r.startsWith('ML_WIN_'))).toBe(false);
  });
});

describe('criterion 3 — nothing else moves', () => {
  const base: EnvelopeInput = {
    rawMlWin: 0.30, calibratedMlWin: 0.50, staleCount: 0, anyKilled: false, macroRisk: 'NONE',
    newsConflicts: false, alignment: 'ALIGNED_BULLISH', alignedDirection: 'LONG',
    continuationCount: 3, isCrypto: true, isStock: false, isTreatment: true, regime: 'TRENDING',
    longConfirmStatus: 'n/a', oneHOpposes: false, cryptoBearRegime: false, daysToEarnings: null,
    mlCoverageCut: 0.42,
  };

  it('the coverage cut REPLACES the level floor on SHORT — a raw 30 bar flats', () => {
    // NOTE the side. The user's reported case was a raw-31 LONG, and that one is deliberately NOT
    // flatted: 0.45 coverage cuts above every LONG band that measured positive, and ML carries no
    // cross-sectional information about long payoff (AUC 0.4993). The floor is a SHORT-side tool.
    const v = evaluateEnvelope({ ...base, alignedDirection: 'SHORT' });
    expect(v.autoFlat.some(r => r.includes('below_live_floor'))).toBe(true);
    expect(v.maxAllowed).toBe('FLAT');
  });

  it('a bar above the cut is NOT flatted by ML', () => {
    const v = evaluateEnvelope({ ...base, alignedDirection: 'SHORT', rawMlWin: 0.55, calibratedMlWin: 0.72 });
    expect(v.autoFlat.some(r => r.startsWith('ML_WIN_'))).toBe(false);
  });

  it('keeps the ML_WIN_ prefix, so the FRAMING hatch still matches', () => {
    // `isQualityGateReason` in prompt.ts tests `startsWith('ML_WIN_')`. Losing that silently killed
    // the hatch for a week in 2026-07-24, and again in the reverted Part 11 change.
    const r = evaluateEnvelope({ ...base, alignedDirection: 'SHORT' })
      .autoFlat.find(x => x.includes('below_live_floor'))!;
    expect(r.startsWith('ML_WIN_')).toBe(true);
  });

  it('the 60 and 70 tiers stay LEVEL-based on the calibrated scale', () => {
    const v = evaluateEnvelope({ ...base, rawMlWin: 0.55, calibratedMlWin: 0.65 });
    expect(v.highBlocks).toContain('ML_WIN_65<70');
    expect(v.moderateBlocks.some(r => r.startsWith('ML_WIN_'))).toBe(false);
  });

  it('is SCOPED TO SHORT, and LONG keeps the level floor', () => {
    // 0.45 coverage cuts at raw 0.491, above all three LONG bands that measured positive — applying
    // it to LONG would have all but eliminated long setups. And the justification for gating on ML
    // is SHORT-side: cross-sectional AUC (within-timestamp, so not a date proxy) is 0.53 on SHORT
    // and 0.4993 on LONG, where the signal carries no information about payoff.
    expect(evaluateEnvelope({ ...base, alignedDirection: 'SHORT' }).autoFlat
      .some(r => r.includes('below_live_floor'))).toBe(true);
    const long = evaluateEnvelope({ ...base, alignedDirection: 'LONG' });
    expect(long.autoFlat.some(r => r.includes('below_live_floor'))).toBe(false);
    // calibrated 50 is not < 50, so the level floor does not flat it either — LONG behaviour is
    // exactly what it was before this change.
    expect(long.autoFlat.some(r => r.startsWith('ML_WIN_'))).toBe(false);
  });

  it('LONG still flats on the LEVEL floor when calibrated drops below 50', () => {
    const v = evaluateEnvelope({ ...base, alignedDirection: 'LONG', calibratedMlWin: 0.40 });
    expect(v.autoFlat.some(r => r.startsWith('ML_WIN_'))).toBe(true);
  });
});
