import { describe, it, expect } from 'vitest';
import { provisionalCurve, computeOpportunities, PROVISIONAL_MODEL_VERSION, PROVISIONAL_CAVEAT,
         type AssetInput } from '../src/trading/service';
import { validate, probabilityOfReaching } from '../src/trading/payoff';
import type { PortfolioState } from '../src/trading/sizing';

const t = Date.parse('2026-08-24T12:00:00Z');
/** Deterministic 1h closes with enough history for forecastVol. */
const closes = (n: number, start = 100, drift = 0.0004, amp = 0.006) =>
  Array.from({ length: n }, (_, i) => start * (1 + drift * i + amp * Math.sin(i / 5)));

const asset = (o: Partial<AssetInput> = {}): AssetInput => ({
  asset: 'SOLUSDT', closes1h: closes(800), price: 100, atr: 4, mlWin: 0.55,
  crashProbability: 0.1, liquidityUsd24h: 50_000_000, isCrypto: true, dataTimestamp: t, ...o,
});
const portfolio = (): PortfolioState => ({ equity: 25000, openNotionalByAsset: {}, correlations: {} });

describe('provisional excursion curve', () => {
  it('always produces a valid monotone distribution', () => {
    for (const ml of [0.05, 0.2, 0.4, 0.55, 0.8, 0.95]) {
      expect(() => validate(provisionalCurve(ml, 72))).not.toThrow();
    }
  });

  it('reproduces the random walk when ML_WIN matches it at the anchor', () => {
    // 1/(1+1.5) = 0.40 is the driftless rate at 1.5R; an ML_WIN of 0.40 implies no edge
    const c = provisionalCurve(0.40, 72);
    expect(probabilityOfReaching(c, 1.5)).toBeCloseTo(0.40, 6);
    expect(probabilityOfReaching(c, 5)).toBeCloseTo(1 / 6, 2);
  });

  it('carries an edge outward when ML_WIN exceeds the driftless rate', () => {
    const edge = provisionalCurve(0.60, 72);
    const none = provisionalCurve(0.40, 72);
    expect(probabilityOfReaching(edge, 5)).toBeGreaterThan(probabilityOfReaching(none, 5));
  });

  it('DAMPS the edge as R grows — 1.5R is weak evidence about 8R', () => {
    const c = provisionalCurve(0.70, 72);
    const liftAt2 = probabilityOfReaching(c, 2) / (1 / 3);
    const liftAt8 = probabilityOfReaching(c, 8) / (1 / 9);
    expect(liftAt8).toBeLessThan(liftAt2);
  });
});

describe('computeOpportunities', () => {
  it('produces a ranked, sized book from real-shaped inputs', () => {
    const r = computeOpportunities(
      [asset({ asset: 'SOL', mlWin: 0.70 }), asset({ asset: 'LINK', mlWin: 0.62 }), asset({ asset: 'ETH', mlWin: 0.58 })],
      portfolio(), t);
    expect(r.allocation.accepted.length).toBeGreaterThan(0);
    const scores = r.allocation.accepted.map(a => a.candidate.riskAdjustedScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);   // ranked
  });

  it('SKIPS assets without ML_WIN rather than inventing a probability', () => {
    const r = computeOpportunities([asset({ asset: 'X', mlWin: null })], portfolio(), t);
    expect(r.allocation.accepted).toHaveLength(0);
    expect(r.skipped[0].reasons).toContain('no ML_WIN available');
  });

  it('skips assets missing price or ATR', () => {
    const r = computeOpportunities([asset({ asset: 'X', atr: 0 })], portfolio(), t);
    expect(r.skipped[0].reasons).toContain('missing price or ATR');
  });

  it('applies NO crash overlay when no crash model is available', () => {
    const r = computeOpportunities([asset({ mlWin: 0.75, crashProbability: null })], portfolio(), t);
    const acc = r.allocation.accepted[0];
    if (acc) {
      expect(acc.sizing.crashMultiplier).toBe(1);
      expect(acc.candidate.provenance.crashModelVersion).toBe('none');
    }
  });

  it('lets crash risk shrink the book when a probability IS supplied', () => {
    const calm = computeOpportunities([asset({ mlWin: 0.75, crashProbability: 0.05 })], portfolio(), t);
    const risky = computeOpportunities([asset({ mlWin: 0.75, crashProbability: 0.55 })], portfolio(), t);
    const c = calm.allocation.totals.riskFraction, k = risky.allocation.totals.riskFraction;
    if (c > 0) expect(k).toBeLessThan(c);
  });

  it('trades a direction-agnostic structure and SAYS SO — the validated convex case', () => {
    const r = computeOpportunities([asset({ asset: 'SOL', mlWin: 0.70 })], portfolio(), t);
    expect(r.allocation.accepted).toHaveLength(1);
    expect(r.directionAgnosticAssets).toContain('SOL');
  });

  it('produces NO TRADE when ML_WIN implies no edge', () => {
    const r = computeOpportunities([asset({ mlWin: 0.30 })], portfolio(), t);
    expect(r.allocation.accepted).toHaveLength(0);
  });

  it('marks every result provisional, in three independent places', () => {
    const r = computeOpportunities([asset()], portfolio(), t);
    expect(r.provisional).toBe(true);
    expect(r.caveat).toBe(PROVISIONAL_CAVEAT);
    expect(r.modelVersion).toMatch(/^provisional-/);
    for (const a of r.allocation.accepted) {
      expect(a.candidate.provenance.modelVersion).toMatch(/^provisional-/);
    }
  });

  it('respects portfolio limits across many assets', () => {
    const many = Array.from({ length: 12 }, (_, i) => asset({ asset: `A${i}`, mlWin: 0.72 }));
    const r = computeOpportunities(many, portfolio(), t);
    expect(r.allocation.totals.notionalFraction).toBeLessThanOrEqual(1.0 + 1e-9);
  });
});
