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

// 2026-07-02 trend-context gates: reversal patterns require a move to reverse. Regression for the
// live "Evening Star at support in oversold" report — a dead-cat-bounce triple inside a DOWNTREND
// must not be labeled Evening Star (bearish top pattern), and the same wick shape must resolve to
// Hammer after a decline vs Hanging Man after an advance (trend, not candle color, disambiguates).
describe('candlePatterns trend gates', () => {
  const mk = (bars: Array<[number, number, number, number]>): Candle[] =>
    bars.map(([o, h, l, c], i) => ({ time: 1600000000000 + i * 86400000, open: o, high: h, low: l, close: c, volume: 1000 }));
  const patterns = (candles: Candle[]) =>
    computeFullIndicators(candles, { timeframe: '1d', label: 'Daily', isCrypto: true }).candlePatterns.map(p => p.pattern);

  it('no Evening Star from a dead-cat bounce inside a downtrend; Morning Star still fires after a decline', () => {
    // Steady decline, then green-bounce / small / red — the OLD code called this Evening Star.
    const down: Array<[number, number, number, number]> = [];
    let p = 200;
    for (let i = 0; i < 10; i++) { down.push([p, p + 1, p - 6, p - 5]); p -= 5; }
    const bounce: Array<[number, number, number, number]> = [
      [p, p + 8, p - 1, p + 7],                    // green bounce bar (c3 > o3)
      [p + 7, p + 8.5, p + 6.5, p + 7.5],          // small bar
      [p + 7.5, p + 8, p + 2, p + 3],              // red bar closing below the green bar's midpoint
    ];
    expect(patterns(mk([...down, ...bounce]))).not.toContain('Evening Star');

    // Classic Morning Star at the end of the same decline still fires (downtrend precedes it).
    const morning: Array<[number, number, number, number]> = [
      [p, p + 0.5, p - 8, p - 7],                  // big red
      [p - 7, p - 6.5, p - 8.5, p - 7.5],          // small bar
      [p - 7.5, p + 1, p - 8, p - 1],              // big green closing above the red bar's midpoint
    ];
    expect(patterns(mk([...down, ...morning]))).toContain('Morning Star');
  });

  it('lower-wick shape = Hammer after a decline, Hanging Man after an advance (same shape, same color)', () => {
    const wickBar = (p: number): [number, number, number, number] => [p, p + 0.4, p - 6, p + 0.3]; // green, long lower wick
    const down: Array<[number, number, number, number]> = []; let d = 200;
    for (let i = 0; i < 8; i++) { down.push([d, d + 1, d - 5, d - 4]); d -= 4; }
    const up: Array<[number, number, number, number]> = []; let u = 100;
    for (let i = 0; i < 8; i++) { up.push([u, u + 5, u - 1, u + 4]); u += 4; }
    const afterDecline = patterns(mk([...down, wickBar(d)]));
    const afterAdvance = patterns(mk([...up, wickBar(u)]));
    expect(afterDecline).toContain('Hammer');
    expect(afterDecline).not.toContain('Hanging Man');
    expect(afterAdvance).toContain('Hanging Man');
    expect(afterAdvance).not.toContain('Hammer');
  });
});
