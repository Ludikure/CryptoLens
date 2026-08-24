import { describe, it, expect } from 'vitest';
import { allocatePortfolio, effectiveBets, simultaneousStopLoss } from '../src/trading/portfolio';
import { DEFAULT_LIMITS, type PortfolioState } from '../src/trading/sizing';
import {
  entryFromCandidate, recordOutcome, recordNotTaken, stats, statsByConfig,
  JournalError, CREATE_TABLE_SQL,
} from '../src/trading/journal';
import type { TradeCandidate, Provenance } from '../src/trading/candidate';

const t = Date.parse('2026-08-24T12:00:00Z');
const prov = (o: Partial<Provenance> = {}): Provenance => ({
  dataTimestamp: t, featureTimestamp: t, decisionTimestamp: t,
  modelVersion: 'm1', crashModelVersion: 'c1', sizingConfigId: 'cfg-A', ...o,
});
const cand = (asset: string, evR = 0.2, o: Partial<TradeCandidate> = {}): TradeCandidate => ({
  asset, direction: 'LONG', entryPrice: 100, stopPrice: 90, targetPrice: 150,
  holdingHorizonHours: 72,
  payoff: { winProbability: 0.3, averageWinR: 5, averageLossR: 1, expectedValueR: evR, payoffAsymmetry: 5, confidence: 0.6 },
  crashRisk: { probability: 0.1, regime: 'LOW', confidence: 0.8, horizonDays: 10 },
  signalStrength: 0.3, riskAdjustedScore: evR, recommendedPositionFraction: 0,
  provenance: prov(), ...o,
});
const liq = (assets: string[]) => Object.fromEntries(assets.map(a => [a, 50_000_000]));

describe('effective bets', () => {
  it('counts uncorrelated positions at face value', () => {
    expect(effectiveBets(['A', 'B', 'C'], { A: { B: 0, C: 0 }, B: { C: 0 } })).toBeCloseTo(3, 6);
  });

  it("collapses correlated crypto: five 0.62-correlated positions are ~1.5 bets", () => {
    const assets = ['A', 'B', 'C', 'D', 'E'];
    const corr: Record<string, Record<string, number>> = {};
    for (const a of assets) { corr[a] = {}; for (const b of assets) if (a !== b) corr[a][b] = 0.62; }
    const eff = effectiveBets(assets, corr);
    expect(eff).toBeGreaterThan(1.4);
    expect(eff).toBeLessThan(1.7);   // NOT five
  });

  it('perfect correlation is one bet', () => {
    expect(effectiveBets(['A', 'B'], { A: { B: 1 }, B: { A: 1 } })).toBeCloseTo(1, 6);
  });
});

describe('portfolio allocation', () => {
  const state = (): PortfolioState => ({ equity: 25000, openNotionalByAsset: {}, correlations: {} });

  it('allocates down the ranked list, best first', () => {
    const r = allocatePortfolio({
      ranked: [cand('SOL', 0.30), cand('LINK', 0.20), cand('ETH', 0.10)],
      state: state(), liquidityByAsset: liq(['SOL', 'LINK', 'ETH']),
    });
    expect(r.accepted.map(a => a.candidate.asset)).toEqual(['SOL', 'LINK', 'ETH']);
    expect(r.totals.positions).toBe(3);
  });

  it('updates state between allocations so shared limits see reality', () => {
    // 10% stop, 2% risk -> 20% notional each; the 100% portfolio cap admits five
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(a => cand(a));
    const r = allocatePortfolio({ ranked: many, state: state(), liquidityByAsset: liq(many.map(c => c.asset)) });
    expect(r.totals.notionalFraction).toBeLessThanOrEqual(1.0 + 1e-9);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejected[0].reasons.join(' ')).toMatch(/portfolio notional|minimum position/);
  });

  it('correlated exposure squeezes later candidates', () => {
    // Each position wants 20% notional (10% stop, 2% risk). With a 50% correlated cap the first two
    // fit at full size and the THIRD is cut to the 10% that remains — the ranking cannot quietly
    // rebuild the concentration T7 measured at 0.62 average pairwise correlation.
    const assets = ['SOL', 'LINK', 'AVAX'];
    const corr: Record<string, Record<string, number>> = {};
    for (const a of assets) { corr[a] = {}; for (const b of assets) if (a !== b) corr[a][b] = 0.85; }
    const r = allocatePortfolio({
      ranked: assets.map(a => cand(a)),
      state: { equity: 25000, openNotionalByAsset: {}, correlations: corr },
      liquidityByAsset: liq(assets),
      limits: { ...DEFAULT_LIMITS, maxCorrelatedNotional: 0.50 },
    });
    const notionals = r.accepted.map(a => a.sizing.notionalFraction);
    expect(notionals[0]).toBeCloseTo(0.20, 6);
    expect(notionals[notionals.length - 1]).toBeCloseTo(0.10, 6);
    expect(r.accepted.some(a => a.sizing.bindingConstraints.includes('correlated exposure'))).toBe(true);
  });

  it('never mutates the caller state', () => {
    const s = state();
    allocatePortfolio({ ranked: [cand('SOL')], state: s, liquidityByAsset: liq(['SOL']) });
    expect(Object.keys(s.openNotionalByAsset)).toHaveLength(0);
  });

  it('reports simultaneous stop loss — correlated books gap together', () => {
    const r = allocatePortfolio({
      ranked: [cand('A'), cand('B'), cand('C')], state: state(), liquidityByAsset: liq(['A', 'B', 'C']),
    });
    expect(simultaneousStopLoss(r.accepted)).toBeCloseTo(r.totals.riskFraction, 10);
    expect(simultaneousStopLoss(r.accepted)).toBeGreaterThan(0.02);   // more than one trade's risk
  });

  it('rejects illiquid assets without stopping the list', () => {
    const r = allocatePortfolio({
      ranked: [cand('THIN'), cand('SOL')],
      state: state(), liquidityByAsset: { THIN: 100, SOL: 50_000_000 },
    });
    expect(r.accepted.map(a => a.candidate.asset)).toEqual(['SOL']);
    expect(r.rejected[0].reasons).toContain('below minimum liquidity');
  });
});

describe('trade journal (spec §18)', () => {
  const mk = () => entryFromCandidate({ ...cand('SOL'), recommendedPositionFraction: 0.02 }, 'j1', t);

  it('freezes the full provenance chain at prediction time', () => {
    const e = mk();
    expect(e.modelVersion).toBe('m1');
    expect(e.configChain).toBe('cfg-A');
    expect(e.outcome).toBeNull();
    expect(e.realizedR).toBeNull();
  });

  it('computes realized R from the ACTUAL fill, not the predicted entry', () => {
    const e = recordOutcome(mk(), {
      actualEntryPrice: 101, actualExitPrice: 151, exitTimestamp: t + 1000,
      maxFavorableExcursionR: 5.0, maxAdverseExcursionR: -0.3, outcome: 'target',
    });
    expect(e.realizedR).toBeCloseTo((151 - 101) / 10, 10);   // risk-per-unit = |100-90| = 10
    expect(e.realizedReturnPct).toBeCloseTo(50 / 101 * 100, 8);
  });

  it('handles SHORT direction sign correctly', () => {
    const short = entryFromCandidate(
      { ...cand('SOL'), direction: 'SHORT', entryPrice: 100, stopPrice: 110, targetPrice: 50 }, 'j2', t);
    const e = recordOutcome(short, {
      actualEntryPrice: 100, actualExitPrice: 90, exitTimestamp: t + 1,
      maxFavorableExcursionR: 1, maxAdverseExcursionR: -0.2, outcome: 'manual_exit',
    });
    expect(e.realizedR).toBeCloseTo(1.0, 10);   // profit on a short
  });

  it('REFUSES to overwrite a resolved outcome — append-only', () => {
    const resolved = recordOutcome(mk(), {
      actualEntryPrice: 100, actualExitPrice: 90, exitTimestamp: t,
      maxFavorableExcursionR: 0, maxAdverseExcursionR: -1, outcome: 'stop',
    });
    expect(() => recordOutcome(resolved, {
      actualEntryPrice: 100, actualExitPrice: 150, exitTimestamp: t,
      maxFavorableExcursionR: 5, maxAdverseExcursionR: 0, outcome: 'target',
    })).toThrow(JournalError);
  });

  it('records a not-taken prediction and excludes it from performance', () => {
    const nt = recordNotTaken(mk(), t + 5);
    expect(nt.outcome).toBe('not_taken');
    const s = stats([nt]);
    expect(s.n).toBe(1);
    expect(s.resolved).toBe(0);
  });

  it('surfaces EV error — realized minus predicted, the honesty number', () => {
    const win = recordOutcome(entryFromCandidate(cand('A', 0.5), 'a', t), {
      actualEntryPrice: 100, actualExitPrice: 150, exitTimestamp: t,
      maxFavorableExcursionR: 5, maxAdverseExcursionR: 0, outcome: 'target',
    });
    const loss = recordOutcome(entryFromCandidate(cand('B', 0.5), 'b', t), {
      actualEntryPrice: 100, actualExitPrice: 90, exitTimestamp: t,
      maxFavorableExcursionR: 0.2, maxAdverseExcursionR: -1, outcome: 'stop',
    });
    const s = stats([win, loss]);
    expect(s.resolved).toBe(2);
    expect(s.hitRate).toBeCloseTo(0.5, 10);
    expect(s.meanRealizedR).toBeCloseTo((5 + -1) / 2, 10);
    expect(s.evError).toBeCloseTo(2 - 0.5, 10);   // model undersold in this sample
  });

  it('slices by config chain so a change is evaluated on its OWN trades', () => {
    const a = recordOutcome(entryFromCandidate(cand('A'), 'a', t), {
      actualEntryPrice: 100, actualExitPrice: 150, exitTimestamp: t,
      maxFavorableExcursionR: 5, maxAdverseExcursionR: 0, outcome: 'target',
    });
    const b = recordOutcome(
      entryFromCandidate({ ...cand('B'), provenance: prov({ sizingConfigId: 'cfg-B' }) }, 'b', t), {
      actualEntryPrice: 100, actualExitPrice: 90, exitTimestamp: t,
      maxFavorableExcursionR: 0, maxAdverseExcursionR: -1, outcome: 'stop',
    });
    const by = statsByConfig([a, b]);
    expect(Object.keys(by).sort()).toEqual(['cfg-A', 'cfg-B']);
    expect(by['cfg-A'].meanRealizedR).toBeGreaterThan(by['cfg-B'].meanRealizedR);
  });

  it('reports NaN rather than 0 when nothing has resolved', () => {
    const s = stats([mk()]);
    expect(Number.isNaN(s.hitRate)).toBe(true);
    expect(s.totalR).toBe(0);
  });

  it('ships a schema with the indexes the queries need', () => {
    expect(CREATE_TABLE_SQL).toMatch(/CREATE TABLE IF NOT EXISTS trade_journal/);
    expect(CREATE_TABLE_SQL).toMatch(/idx_journal_config/);
  });
});
