import { describe, it, expect } from 'vitest';
import {
  riskPerUnit, structureR, isValidGeometry, noTrade, isNoTrade, type Provenance,
} from '../src/trading/candidate';
import {
  assertNoLookahead, assertPurgeCoversHorizon, assertBackwardOnly,
  findLookaheadViolations, LookaheadError,
} from '../src/trading/provenance';
import {
  crashMultiplier, crashRegime, applyCrashOverlay, PLACEHOLDER_CURVE, NEUTRAL_CURVE,
} from '../src/trading/crash-risk';
import {
  sizePosition, baseRiskFraction, correlatedExposure, DEFAULT_LIMITS, type PortfolioState,
} from '../src/trading/sizing';
import {
  expectedValueR, netExpectedValueR, buildPayoff, opportunityScore, rankCandidates,
  chooseDirection, DEFAULT_SCORING,
} from '../src/trading/opportunity';

const t = Date.parse('2026-08-24T12:00:00Z');
const prov = (o: Partial<Provenance> = {}): Provenance => ({
  dataTimestamp: t, featureTimestamp: t, decisionTimestamp: t,
  modelVersion: 'test', crashModelVersion: 'test', sizingConfigId: 'test', ...o,
});
const portfolio = (o: Partial<PortfolioState> = {}): PortfolioState => ({
  equity: 25000, openNotionalByAsset: {}, correlations: {}, ...o,
});

describe('candidate geometry', () => {
  it('computes R distance and structure reward', () => {
    expect(riskPerUnit(100, 95)).toBeCloseTo(0.05, 10);
    expect(structureR(100, 95, 115, 'LONG')).toBeCloseTo(3, 10);
    expect(structureR(100, 105, 85, 'SHORT')).toBeCloseTo(3, 10);
  });

  it('rejects a stop on the wrong side — the 2026-07-14 defect', () => {
    // a SHORT whose stop sits BELOW entry is unsizable: risk-per-unit points the wrong way
    expect(isValidGeometry({ direction: 'SHORT', entryPrice: 63732, stopPrice: 62958, targetPrice: 61000 })).toBe(false);
    expect(isValidGeometry({ direction: 'SHORT', entryPrice: 63732, stopPrice: 64500, targetPrice: 61000 })).toBe(true);
  });

  it('produces an explicit NO TRADE', () => {
    const n = noTrade('BTCUSDT', prov());
    expect(isNoTrade(n)).toBe(true);
    expect(n.recommendedPositionFraction).toBe(0);
  });
});

describe('anti-lookahead (spec §20)', () => {
  it('rejects features that postdate the decision — the T10 defect', () => {
    expect(() => assertNoLookahead(prov({ featureTimestamp: t + 1 }))).toThrow(LookaheadError);
  });

  it('rejects data that postdates the decision', () => {
    expect(() => assertNoLookahead(prov({ dataTimestamp: t + 60_000 }))).toThrow(/data timestamp/);
  });

  it('allows equality — features computed exactly at decision time are legitimate', () => {
    expect(() => assertNoLookahead(prov())).not.toThrow();
  });

  it('requires a stated reason before granting any tolerance', () => {
    expect(() => assertNoLookahead(prov({ featureTimestamp: t + 5 }), 10)).toThrow(/explicit reason/);
    expect(() => assertNoLookahead(prov({ featureTimestamp: t + 5 }), 10, 'bar stamped at open')).not.toThrow();
  });

  it('rejects a purge shorter than the label horizon — the T2 defect', () => {
    expect(() => assertPurgeCoversHorizon(48, 60)).toThrow(/shorter than/);
    expect(() => assertPurgeCoversHorizon(72, 60)).not.toThrow();
  });

  it('rejects a full-sample statistic applied backwards', () => {
    expect(() => assertBackwardOnly(t + 1000, t, 'percentile threshold')).toThrow(/leaking backwards/);
  });

  it('reports every violation in a batch rather than the first', () => {
    const v = findLookaheadViolations([
      { asset: 'A', provenance: prov({ featureTimestamp: t + 1 }) },
      { asset: 'B', provenance: prov() },
      { asset: 'C', provenance: prov({ dataTimestamp: t + 1 }) },
    ]);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatch(/^A:/);
  });
});

describe('crash overlay (spec §6, §7)', () => {
  it('steps down through the placeholder curve', () => {
    expect(crashMultiplier(0.10)).toBe(1.00);
    expect(crashMultiplier(0.35)).toBe(0.75);
    expect(crashMultiplier(0.55)).toBe(0.50);
    expect(crashMultiplier(0.80)).toBe(0.00);
  });

  it('does not interpolate — an applied multiplier is always an exact curve value', () => {
    // 0.49 sits between breakpoints; it must take the LOWER breakpoint's value, not a blend
    expect(crashMultiplier(0.49)).toBe(0.75);
    expect([1, 0.75, 0.5, 0]).toContain(crashMultiplier(0.63));
  });

  it('labels the regime consistently with the multiplier', () => {
    expect(crashRegime(0.10)).toBe('LOW');
    expect(crashRegime(0.80)).toBe('EXTREME');
  });

  it('can only SCALE an existing position, never create one (spec §7)', () => {
    const closed = applyCrashOverlay(0, { probability: 0.05, regime: 'LOW', confidence: 1, horizonDays: 10 });
    expect(closed.fraction).toBe(0);   // low crash risk cannot open a trade
  });

  it('has NO exposure floor — T15 showed a floor destroys the protection', () => {
    const r = applyCrashOverlay(0.02, { probability: 0.9, regime: 'EXTREME', confidence: 1, horizonDays: 10 });
    expect(r.fraction).toBe(0);
  });

  it('the neutral control never adjusts', () => {
    const r = applyCrashOverlay(0.02, { probability: 0.99, regime: 'EXTREME', confidence: 1, horizonDays: 10 }, NEUTRAL_CURVE);
    expect(r.fraction).toBeCloseTo(0.02, 10);
    expect(r.curveId).toBe('neutral-control');
  });

  it('carries a curve id so a silent retune is detectable', () => {
    expect(PLACEHOLDER_CURVE.id).toBe('placeholder-2026-08-24');
    expect(PLACEHOLDER_CURVE.description).toMatch(/NOT fitted/);
  });
});

describe('expected value (spec §3)', () => {
  it('never assumes 1:1 and ranks the four cases correctly', () => {
    const hiProbPoorPayoff = expectedValueR(0.70, 1.0, 1.0);
    const loProbGreatPayoff = expectedValueR(0.20, 5.0, 1.0);
    const balanced = expectedValueR(0.55, 2.0, 1.0);
    const bad = expectedValueR(0.35, 1.2, 1.0);
    expect(balanced).toBeGreaterThan(hiProbPoorPayoff);
    expect(hiProbPoorPayoff).toBeGreaterThan(loProbGreatPayoff);
    expect(bad).toBeLessThan(0);
  });

  it('converts round-trip cost into R using the STOP distance', () => {
    // 0.171% round trip: 0.171R against a 1% stop, 0.0342R against a 5% stop
    expect(netExpectedValueR(0.5, 0.171, 1)).toBeCloseTo(0.5 - 0.171, 6);
    expect(netExpectedValueR(0.5, 0.171, 5)).toBeCloseTo(0.5 - 0.0342, 6);
  });

  it('builds a payoff whose asymmetry is pure geometry', () => {
    const p = buildPayoff({
      winProbability: 0.3, entryPrice: 100, stopPrice: 99, targetPrice: 105,
      direction: 'LONG', confidence: 0.6, roundTripPercent: 0.171,
    });
    expect(p.payoffAsymmetry).toBeCloseTo(5, 10);
    expect(p.averageLossR).toBe(1);
  });
});

describe('ranking (spec §8)', () => {
  it('does NOT rank by probability', () => {
    const hi = buildPayoff({ winProbability: 0.70, entryPrice: 100, stopPrice: 99, targetPrice: 101, direction: 'LONG', confidence: 0.5, roundTripPercent: 0 });
    const mid = buildPayoff({ winProbability: 0.55, entryPrice: 100, stopPrice: 99, targetPrice: 102, direction: 'LONG', confidence: 0.5, roundTripPercent: 0 });
    expect(mid.winProbability).toBeLessThan(hi.winProbability);
    expect(opportunityScore(mid, 0)).toBeGreaterThan(opportunityScore(hi, 0));
  });

  it('drops non-positive EV rather than ranking it last', () => {
    const base = { asset: 'X', direction: 'LONG' as const, entryPrice: 100, stopPrice: 99, targetPrice: 105,
      holdingHorizonHours: 72, crashRisk: { probability: 0.1, regime: 'LOW' as const, confidence: 1, horizonDays: 10 },
      signalStrength: 0, riskAdjustedScore: 0, recommendedPositionFraction: 0.01, provenance: prov() };
    const good = { ...base, payoff: buildPayoff({ winProbability: 0.4, entryPrice: 100, stopPrice: 99, targetPrice: 105, direction: 'LONG', confidence: 0.6, roundTripPercent: 0 }) };
    const bad = { ...base, asset: 'Y', payoff: buildPayoff({ winProbability: 0.05, entryPrice: 100, stopPrice: 99, targetPrice: 102, direction: 'LONG', confidence: 0.6, roundTripPercent: 0 }) };
    const ranked = rankCandidates([good, bad]);
    expect(ranked.map(c => c.asset)).toEqual(['X']);
  });

  it('returns null on a near-tie in direction — a coin flip is not a choice', () => {
    const mk = (ev: number) => ({ payoff: { expectedValueR: ev } } as any);
    expect(chooseDirection(mk(0.10), mk(0.09))).toBeNull();
    expect(chooseDirection(mk(0.30), mk(0.09))?.payoff.expectedValueR).toBe(0.30);
  });
});

describe('sizing engine (spec §9, §10)', () => {
  const base = {
    asset: 'SOLUSDT', direction: 'LONG' as const, entryPrice: 100, stopPrice: 96,
    expectedValueR: 0.18, liquidityUsd24h: 50_000_000,
    crashRisk: { probability: 0.10, regime: 'LOW' as const, confidence: 0.8, horizonDays: 10 },
  };

  it('sizes from the STOP, not from confidence', () => {
    // 10% stop: risking 2% implies 20% of equity in notional, comfortably under the 35% cap
    const r = sizePosition({ ...base, stopPrice: 90, portfolio: portfolio() });
    expect(r.riskFraction).toBeCloseTo(0.02, 6);
    expect(r.notionalFraction).toBeCloseTo(0.20, 6);
  });

  it('a TIGHT stop hits the notional cap, which then reduces realised risk', () => {
    // 4% stop: risking the full 2% would need 50% of equity in notional. The cap binds at 35%,
    // so realised risk falls to 0.35 x 0.04 = 1.4%. The engine may only ever reduce.
    const r = sizePosition({ ...base, portfolio: portfolio() });   // entry 100, stop 96
    expect(r.notionalFraction).toBeCloseTo(0.35, 6);
    expect(r.riskFraction).toBeCloseTo(0.014, 6);
    expect(r.bindingConstraints).toContain('max position notional');
    expect(r.riskFraction).toBeLessThan(DEFAULT_LIMITS.maxRiskPerTrade);
  });

  it('does NOT scale with expected value — H4 showed proportional sizing loses', () => {
    const small = sizePosition({ ...base, expectedValueR: 0.02, portfolio: portfolio() });
    const large = sizePosition({ ...base, expectedValueR: 2.00, portfolio: portfolio() });
    expect(small.riskFraction).toBeCloseTo(large.riskFraction, 10);
  });

  it('a high-confidence estimate cannot exceed the hard limit', () => {
    const r = sizePosition({ ...base, expectedValueR: 99, portfolio: portfolio() });
    expect(r.riskFraction).toBeLessThanOrEqual(DEFAULT_LIMITS.maxRiskPerTrade);
  });

  it('crash risk shrinks the position and names itself as binding', () => {
    const r = sizePosition({ ...base, crashRisk: { probability: 0.55, regime: 'HIGH', confidence: 0.8, horizonDays: 10 }, portfolio: portfolio() });
    expect(r.crashMultiplier).toBe(0.5);
    expect(r.bindingConstraints.join(' ')).toMatch(/crash HIGH/);
  });

  it('extreme crash risk closes the position entirely', () => {
    const r = sizePosition({ ...base, crashRisk: { probability: 0.85, regime: 'EXTREME', confidence: 0.9, horizonDays: 10 }, portfolio: portfolio() });
    expect(r.riskFraction).toBe(0);
  });

  it('enforces asset concentration', () => {
    const r = sizePosition({ ...base, portfolio: portfolio({ openNotionalByAsset: { SOLUSDT: 0.34 } }) });
    expect(r.notionalFraction).toBeLessThanOrEqual(0.01 + 1e-9);
    expect(r.bindingConstraints).toContain('asset concentration');
  });

  it('enforces correlated exposure across different assets', () => {
    const p = portfolio({
      openNotionalByAsset: { ETHUSDT: 0.30, BTCUSDT: 0.28 },
      correlations: { SOLUSDT: { ETHUSDT: 0.85, BTCUSDT: 0.80 } },
    });
    expect(correlatedExposure('SOLUSDT', p, 0.70)).toBeCloseTo(0.58, 10);
    const r = sizePosition({ ...base, portfolio: p });
    expect(r.bindingConstraints).toContain('correlated exposure');
  });

  it('refuses illiquid assets', () => {
    const r = sizePosition({ ...base, liquidityUsd24h: 100, portfolio: portfolio() });
    expect(r.riskFraction).toBe(0);
    expect(r.bindingConstraints).toContain('below minimum liquidity');
  });

  it('returns NO TRADE on non-positive expected value', () => {
    const r = sizePosition({ ...base, expectedValueR: -0.01, portfolio: portfolio() });
    expect(r.riskFraction).toBe(0);
  });

  it('records the config ids so a trade is reproducible', () => {
    const r = sizePosition({ ...base, portfolio: portfolio() });
    expect(r.curveId).toBe('placeholder-2026-08-24');
    expect(r.limitsId).toBe('default-2026-08-24');
  });

  it('baseRiskFraction is binary, never proportional', () => {
    expect(baseRiskFraction(0.01, DEFAULT_LIMITS)).toBe(DEFAULT_LIMITS.maxRiskPerTrade);
    expect(baseRiskFraction(5.00, DEFAULT_LIMITS)).toBe(DEFAULT_LIMITS.maxRiskPerTrade);
    expect(baseRiskFraction(0, DEFAULT_LIMITS)).toBe(0);
  });
});
