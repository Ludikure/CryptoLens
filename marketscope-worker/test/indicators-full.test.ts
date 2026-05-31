import { describe, it, expect } from 'vitest';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

// Smoke test: confirms the full-indicator port compiles, runs on a realistic series, and emits
// the complete shape (scalars + series + levels). Exact iOS parity is a follow-up fixture.

function synth(n: number, drift: number): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += drift + Math.sin(i / 7) * 1.5;          // deterministic wiggle + drift
    const o = p, c = p + drift * 0.4, h = Math.max(o, c) + 0.8, l = Math.min(o, c) - 0.8;
    out.push({ time: 1600000000000 + i * 86400000, open: o, high: h, low: l, close: c, volume: 1000 + (i % 5) * 100 });
  }
  return out;
}

describe('computeFullIndicators', () => {
  it('runs on a daily series and returns the full shape', () => {
    const r = computeFullIndicators(synth(250, 0.5), { timeframe: '1d', label: 'Daily', isCrypto: true });
    // scalars
    expect(typeof r.price).toBe('number');
    expect(r.rsi).not.toBeNull();
    expect(['Strong Bullish', 'Bullish', 'Neutral', 'Bearish', 'Strong Bearish']).toContain(r.bias);
    expect(typeof r.biasScore).toBe('number');
    expect(r.atr!.atr).toBeGreaterThan(0);
    // levels
    expect(Array.isArray(r.supportResistance.supports)).toBe(true);
    expect(Array.isArray(r.supportResistance.resistances)).toBe(true);
    expect(r.fibonacci).not.toBeNull();
    expect(r.marketStructure).not.toBeNull();
    // series present + capped at 50
    expect(r.rsiSeries.length).toBeGreaterThan(0);
    expect(r.candles.length).toBeLessThanOrEqual(50);
    expect(r.macdLineSeries.length).toBeLessThanOrEqual(50);
    expect(r.adxSeries.length).toBeLessThanOrEqual(50);
    expect(r.ema20Series.length).toBeLessThanOrEqual(50);
  });

  it('uptrend series leans bullish, downtrend leans bearish', () => {
    const up = computeFullIndicators(synth(250, 0.8), { timeframe: '1d', label: 'Daily', isCrypto: true });
    const down = computeFullIndicators(synth(250, -0.8), { timeframe: '1d', label: 'Daily', isCrypto: true });
    expect(up.biasScore).toBeGreaterThanOrEqual(down.biasScore);
  });

  it('stock path emits OBV / AD trend objects', () => {
    const r = computeFullIndicators(synth(250, 0.5), { timeframe: '1d', label: 'Daily', isCrypto: false });
    expect(r.obv).not.toBeNull();
    expect(r.adLine).not.toBeNull();
  });
});
