import { describe, it, expect } from 'vitest';
import { logReturns, pearson, beta, effectivePositions, correlationReport } from '../src/correlation';

describe('correlation — concentration risk', () => {
  it('pearson: perfectly correlated = 1, anti = -1', () => {
    const a = [1, 2, 3, 4, 5, 6], b = [2, 4, 6, 8, 10, 12];
    expect(pearson(a, b)).toBeCloseTo(1, 6);
    expect(pearson(a, [6, 5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('beta: 2x-moving asset has β≈2', () => {
    const bench = [0.01, -0.02, 0.03, -0.01, 0.02, 0.01];
    const asset = bench.map(x => x * 2);
    expect(beta(asset, bench)).toBeCloseTo(2, 6);
  });

  it('effectivePositions collapses with correlation', () => {
    expect(effectivePositions(0, 5)).toBeCloseTo(5, 6);     // independent
    expect(effectivePositions(1, 5)).toBeCloseTo(1, 6);     // all the same trade
    expect(effectivePositions(0.91, 5)).toBeCloseTo(5 / (1 + 4 * 0.91), 4);  // ~1.08
  });

  it('correlationReport on a BTC-led basket flags concentration', () => {
    // build closes where ETH/SOL track BTC closely
    const btc = Array.from({ length: 40 }, (_, i) => 60000 * Math.exp(0.01 * Math.sin(i / 3)));
    const eth = btc.map((p, i) => p * 0.05 * (1 + 0.001 * Math.cos(i / 5)));
    const sol = btc.map((p, i) => p * 0.002 * (1 + 0.001 * Math.sin(i / 4)));
    const r = correlationReport({ BTCUSDT: btc, ETHUSDT: eth, SOLUSDT: sol }, 'BTCUSDT')!;
    expect(r.benchmark).toBe('BTCUSDT');
    expect(r.symbols.length).toBe(3);
    expect(r.avgCorrToBenchmark).toBeGreaterThan(0.8);       // alts track BTC
    expect(r.effectivePositions).toBeLessThan(3);            // not 3 independent bets
    expect(r.betaToBenchmark.BTCUSDT).toBeCloseTo(1, 2);     // β of benchmark to itself = 1
    expect(correlationReport({ BTCUSDT: btc }, 'BTCUSDT')).toBeNull();  // need ≥2 symbols
  });
});
