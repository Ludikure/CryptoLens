import { describe, it, expect } from 'vitest';
import { scoreSnapshot, CRYPTO_PARAMS, STOCK_PARAMS, type ScoringSnapshot } from '../src/scoring-ios';

// Smoke + logic tests for the faithful iOS scorer port. Confirms it compiles, runs, and the
// threshold/gate logic behaves directionally. Exact value parity vs iOS ScoringFunction is a
// follow-up that needs a captured fixture (the ParityFixture mechanism), like the ML features.

const base: ScoringSnapshot = {
  timeframe: '1d', isCrypto: true,
  ema20: 100, ema50: 95, ema200: 90, emaCrossCount: 3, ema20Rising: true,
  stackBullish: true, stackBearish: false, structureBullish: true, structureBearish: false,
  adxValue: 35, adxBullish: true,
  rsi: 38, macdHistogram: 1.2, macdCrossover: 'bullish', macdHistAboveDeadZone: true,
  stochK: 20, stochCrossover: 'bullish', aboveVwap: true, divergence: null,
  last3Green: true, last3Red: false, last3VolIncreasing: true, currentRSI: 38,
  crossAssetSignal: 2, volScalar: 1.0,
  obvRising: true, adLineAccumulation: true, derivativesCombinedSignal: 2,
};

describe('scoreSnapshot (iOS scorer port)', () => {
  it('runs and returns {score, bias}', () => {
    const r = scoreSnapshot(base, CRYPTO_PARAMS);
    expect(typeof r.score).toBe('number');
    expect(['Strong Bullish', 'Bullish', 'Neutral', 'Bearish', 'Strong Bearish']).toContain(r.bias);
  });

  it('strong bullish stack → bullish-side bias + positive score', () => {
    const r = scoreSnapshot(base, CRYPTO_PARAMS);
    expect(r.score).toBeGreaterThan(0);
    expect(r.bias.includes('Bullish')).toBe(true);
  });

  it('inverted bearish snapshot → bearish-side bias + negative score', () => {
    const bear: ScoringSnapshot = {
      ...base, emaCrossCount: 0, stackBullish: false, stackBearish: true,
      structureBullish: false, structureBearish: true, adxBullish: false,
      rsi: 62, macdHistogram: -1.2, macdCrossover: 'bearish',
      stochK: 80, stochCrossover: 'bearish', aboveVwap: false,
      last3Green: false, last3Red: true, currentRSI: 62, crossAssetSignal: -2,
      obvRising: false, adLineAccumulation: false, derivativesCombinedSignal: -2,
    };
    const r = scoreSnapshot(bear, CRYPTO_PARAMS);
    expect(r.score).toBeLessThan(0);
    expect(r.bias.includes('Bearish')).toBe(true);
  });

  it('neutral-ish snapshot → Neutral', () => {
    const neutral: ScoringSnapshot = {
      ...base, emaCrossCount: 2, stackBullish: false, stackBearish: false,
      structureBullish: false, structureBearish: false, adxValue: 15, adxBullish: true,
      rsi: 50, macdHistogram: 0, macdCrossover: null, macdHistAboveDeadZone: false,
      stochK: 50, stochCrossover: null, divergence: null,
      last3Green: false, last3VolIncreasing: false, currentRSI: 50,
      crossAssetSignal: 0, derivativesCombinedSignal: 0,
    };
    const r = scoreSnapshot(neutral, CRYPTO_PARAMS);
    expect(r.bias).toBe('Neutral');
  });

  it('stock params apply (no derivatives layer)', () => {
    const r = scoreSnapshot({ ...base, isCrypto: false }, STOCK_PARAMS);
    expect(typeof r.score).toBe('number');
  });
});
