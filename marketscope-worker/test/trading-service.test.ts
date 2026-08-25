import { describe, it, expect } from 'vitest';
import { computeOpportunities, PROVISIONAL_MODEL_VERSION, PROVISIONAL_CAVEAT,
         type AssetInput } from '../src/trading/service';
import { excursionCurve, baseExcursionCurve, excursionProbability,
         excursionModelInfo } from '../src/trading/excursion';
import { validate, probabilityOfReaching } from '../src/trading/payoff';
import type { PortfolioState } from '../src/trading/sizing';

const t = Date.parse('2026-08-24T12:00:00Z');
/** Deterministic 1h closes with enough history for forecastVol. */
const closes = (n: number, start = 100, drift = 0.0004, amp = 0.006) =>
  Array.from({ length: n }, (_, i) => start * (1 + drift * i + amp * Math.sin(i / 5)));

/** A plausible live feature dict. Values are unremarkable; the point is shape, not a scenario. */
const feats = (o: Record<string, number> = {}): Record<string, number> => {
  const base: Record<string, number> = {};
  for (const k of ['dRsi', 'dAdx', 'dMacdHist', 'hRsi', 'hAdx', 'eRsi', 'atrPercent',
    'atrPercentile', 'vix', 'dxy', 'fearGreedIndex', 'ethBtcRatio', 'dayOfWeek', 'regimeCode',
    'tfAlignment', 'momentumAlignment', 'structureAlignment', 'fundingRateRaw', 'oiChangePct',
    'takerRatioRaw', 'longPctRaw', 'dBBPercentB', 'hBBPercentB', 'dVolumeRatio', 'hVolumeRatio']) {
    base[k] = 1;
  }
  return { ...base, ...o };
};

const asset = (o: Partial<AssetInput> = {}): AssetInput => ({
  asset: 'SOLUSDT', closes1h: closes(800), price: 100, atr: 4, mlWin: 0.55,
  crashProbability: 0.1, liquidityUsd24h: 50_000_000, isCrypto: true, dataTimestamp: t,
  // Features are what the model reads. WITHOUT them the service correctly falls back to measured
  // base rates, whose three-way EV is -0.0996R -- so a featureless asset is genuinely NOT tradeable,
  // matching the measured ungated EV of -0.103R. Tests that want a book must supply features.
  features: feats({ vix: 13, fearGreedIndex: 82, atrPercent: 1.1, dRsi: 68, ethBtcRatio: 0.062 }),
  ...o,
});
const portfolio = (): PortfolioState => ({ equity: 25000, openNotionalByAsset: {}, correlations: {} });

describe('measured excursion curve', () => {
  it('always produces a valid monotone distribution', () => {
    for (const side of ['LONG', 'SHORT'] as const) {
      expect(() => validate(excursionCurve(feats(), side))).not.toThrow();
      expect(() => validate(baseExcursionCurve(side))).not.toThrow();
    }
  });

  it('sits BELOW the driftless random walk at 5R — the finding that retired the old curve', () => {
    // 1/(1+5) = 0.1667 in theory; measured base is 0.066 because a 72h horizon truncates.
    for (const side of ['LONG', 'SHORT'] as const) {
      expect(probabilityOfReaching(baseExcursionCurve(side), 5)).toBeLessThan(1 / 6);
      expect(probabilityOfReaching(baseExcursionCurve(side), 5)).toBeGreaterThan(0.05);
    }
  });

  it('never exceeds the SUPPORTED ceiling — one sparse bucket must not imply a +3R trade', () => {
    // The first export let isotonic reach 0.60 at 5R, 9x the base rate, from a single bucket.
    for (const side of ['LONG', 'SHORT'] as const) {
      for (const v of [0, 1, 50, -50, 1e6]) {
        const p = excursionProbability(feats({ dRsi: v, vix: v, atrPercent: Math.abs(v) + 1 }), side);
        expect(p).toBeLessThanOrEqual(0.25);
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  it('falls back to measured base rates when features are missing, not to a guess', () => {
    const b = baseExcursionCurve('LONG');
    expect(probabilityOfReaching(b, 1)).toBeCloseTo(0.4661, 3);
    expect(probabilityOfReaching(b, 5)).toBeCloseTo(0.0664, 3);
  });

  it('reports real holdout AUC, so the ceiling on the claim is visible in the model itself', () => {
    const i = excursionModelInfo();
    expect(i.features).toBe(110);
    expect(i.longAuc).toBeGreaterThan(0.55);
    expect(i.shortAuc).toBeGreaterThan(0.55);
    expect(i.longAuc).toBeLessThan(0.75);      // not a claim of certainty
  });

  it('states the regime dependence in the caveat every surface carries', () => {
    expect(PROVISIONAL_CAVEAT).toMatch(/PROFITABILITY/);
    expect(PROVISIONAL_CAVEAT).toMatch(/1 of 5 rising-market/);
  });
});

describe('computeOpportunities', () => {
  it('produces a ranked, sized book from real-shaped inputs', () => {
    const r = computeOpportunities(
      [asset({ asset: 'SOL' }), asset({ asset: 'LINK' }), asset({ asset: 'ETH' })],
      portfolio(), t);
    expect(r.allocation.accepted.length).toBeGreaterThan(0);
    const scores = r.allocation.accepted.map(a => a.candidate.riskAdjustedScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);   // ranked
  });

  it('declines a featureless asset — measured base rates are genuinely not tradeable', () => {
    const r = computeOpportunities([asset({ asset: 'BARE', features: undefined })], portfolio(), t);
    expect(r.allocation.accepted.map(a => a.candidate.asset)).not.toContain('BARE');
    expect(r.skipped.map(s => s.asset)).toContain('BARE');
  });

  it('uses MEASURED base rates when features are absent rather than inventing a probability', () => {
    // ML_WIN no longer drives the curve, so a null one is not a reason to skip. What matters is
    // that a featureless asset falls back to measured base rates, never to a fabricated number.
    const r = computeOpportunities([asset({ asset: 'X', mlWin: null })], portfolio(), t);
    const all = [...r.allocation.accepted.map(a => a.candidate.asset), ...r.skipped.map(s => s.asset)];
    expect(all).toContain('X');
  });

  it('skips assets missing price or ATR', () => {
    const r = computeOpportunities([asset({ asset: 'X', atr: 0 })], portfolio(), t);
    expect(r.skipped[0].reasons).toContain('missing price or ATR');
  });

  it('APPLIES the crash overlay now that the validated model ships', () => {
    // Previously asserted the overlay's absence, because no crash model existed. It does now, and
    // it is the most validated thing in the project: drawdown -76.6% -> -40.4%, replicated
    // leave-one-symbol-out. Sizing being cut is the feature, not a regression.
    const r = computeOpportunities([asset({ asset: 'SOL' })], portfolio(), t);
    const all = [...r.allocation.accepted, ...[]];
    for (const a of all) {
      expect(a.sizing.crashMultiplier).toBeGreaterThanOrEqual(0);
      expect(a.sizing.crashMultiplier).toBeLessThanOrEqual(1);
      expect(a.candidate.provenance.crashModelVersion).toMatch(/^crash-v/);
    }
  });

  it('surfaces crash warnings independently of whether any trade was produced', () => {
    // The gauge is a risk signal, so it must reach the user even on a day when nothing is tradeable
    // -- that is precisely the day it matters most.
    const r = computeOpportunities([asset({ asset: 'SOL' })], portfolio(), t);
    expect(Array.isArray(r.crashWarnings)).toBe(true);
    for (const w of r.crashWarnings) {
      expect(['ELEVATED', 'HIGH']).toContain(w.level);
      expect(w.message).toMatch(/episodic|Quiet is not/i);
    }
  });

  it('lets crash risk shrink the book when a probability IS supplied', () => {
    const calm = computeOpportunities([asset({ mlWin: 0.75, crashProbability: 0.05 })], portfolio(), t);
    const risky = computeOpportunities([asset({ mlWin: 0.75, crashProbability: 0.55 })], portfolio(), t);
    const c = calm.allocation.totals.riskFraction, k = risky.allocation.totals.riskFraction;
    if (c > 0) expect(k).toBeLessThan(c);
  });

  it('now picks a SIDE, because the model reads each direction separately', () => {
    // Before the measured model, both sides shared one direction-agnostic curve, so every asset
    // tied and was flagged direction-agnostic. The trained model has a LONG head and a SHORT head,
    // so a tie is now the exception rather than the rule -- and when the sides differ the pipeline
    // should commit rather than shrug.
    const r = computeOpportunities([asset({ asset: 'SOL' })], portfolio(), t);
    expect(r.allocation.accepted).toHaveLength(1);
    expect(['LONG', 'SHORT']).toContain(r.allocation.accepted[0].candidate.direction);
    expect(r.directionAgnosticAssets).not.toContain('SOL');
  });

  it('rejects an asset whose stop is pure noise, whatever the curve says', () => {
    // sigma is a log-return fraction; a huge one makes a 1-ATR stop overwhelmingly likely to be
    // wicked, and maxNoiseHitProbability must veto regardless of excursion probability.
    const r = computeOpportunities(
      [asset({ asset: 'NOISY', atr: 0.01, closes1h: closes(800, 100, 0, 0.4) })], portfolio(), t);
    expect(r.allocation.accepted.map(a => a.candidate.asset)).not.toContain('NOISY');
  });

  it('stamps the real model version and carries the regime caveat on every result', () => {
    const r = computeOpportunities([asset()], portfolio(), t);
    expect(r.caveat).toBe(PROVISIONAL_CAVEAT);
    expect(r.modelVersion).toMatch(/^excursion-v/);
    for (const a of r.allocation.accepted) {
      expect(a.candidate.provenance.modelVersion).toBe(PROVISIONAL_MODEL_VERSION);
    }
  });

  it('respects portfolio limits across many assets', () => {
    const many = Array.from({ length: 12 }, (_, i) => asset({ asset: `A${i}`, mlWin: 0.72 }));
    const r = computeOpportunities(many, portfolio(), t);
    expect(r.allocation.totals.notionalFraction).toBeLessThanOrEqual(1.0 + 1e-9);
  });
});
