import { describe, it, expect } from 'vitest';
import { performance, turnover, applyCosts, auc, discrimination, type Observation } from '../src/trading/metrics';
import {
  evaluate, survivesControls, SHUFFLED_TIMING, RANDOM_LABELS, lagControl, MANDATORY_CONTROLS,
} from '../src/trading/harness';

describe('performance metrics', () => {
  it('computes CAGR, drawdown and Calmar consistently', () => {
    const r = Array(365).fill(0.001);            // ~1%/day compounding for a year
    const m = performance(r);
    expect(m.cagr).toBeGreaterThan(0.4);
    expect(m.maxDrawdown).toBe(0);
    expect(Number.isNaN(m.calmar)).toBe(true);   // undefined without a drawdown, NOT Infinity
  });

  it('measures drawdown and time underwater', () => {
    const m = performance([0.1, -0.5, 0.1, 0.1]);
    expect(m.maxDrawdown).toBeLessThan(-0.4);
    expect(m.timeUnderwater).toBeGreaterThan(0);
    expect(m.longestDrawdownPeriods).toBeGreaterThanOrEqual(3);
  });

  it('separates Sortino from Sharpe by penalising only downside', () => {
    const m = performance([0.02, 0.02, 0.02, -0.01]);
    expect(m.sortino).toBeGreaterThan(m.sharpe);
  });

  it('handles an empty series without throwing', () => {
    expect(performance([]).periods).toBe(0);
  });
});

describe('costs and turnover (spec §22)', () => {
  it('annualises turnover from the weight path', () => {
    const w = Array.from({ length: 365 }, (_, i) => (i % 2 ? 1 : 0));   // flip daily
    expect(turnover(w)).toBeGreaterThan(300);
  });

  it('charges cost on the CHANGE in exposure, not on being invested', () => {
    const held = applyCosts([0.01, 0.01, 0.01], [1, 1, 1], 0.0025);
    expect(held[1]).toBeCloseTo(0.01, 10);       // no trade, no cost
    const flipped = applyCosts([0.01, 0.01], [0, 1], 0.0025);
    expect(flipped[1]).toBeCloseTo(0.01 - 0.0025, 10);
  });
});

describe('AUC', () => {
  it('is 1.0 for perfect separation and 0.5 for none', () => {
    expect(auc([1, 2, 3, 4], [0, 0, 1, 1])).toBeCloseTo(1, 10);
    // balanced concordance: pos {2,3} vs neg {1,4} gives exactly 2 of 4 pairs
    expect(auc([1, 2, 3, 4], [0, 1, 1, 0])).toBeCloseTo(0.5, 10);
    // and the interleaved case is genuinely 0.75, not 0.5 — 3 of 4 pairs concordant
    expect(auc([1, 2, 3, 4], [0, 1, 0, 1])).toBeCloseTo(0.75, 10);
  });

  it('handles ties by averaging ranks', () => {
    expect(auc([1, 1, 1, 1], [0, 0, 1, 1])).toBeCloseTo(0.5, 10);
  });

  it('returns NaN when a class is missing rather than a misleading number', () => {
    expect(Number.isNaN(auc([1, 2, 3], [1, 1, 1]))).toBe(true);
  });
});

describe('discrimination — BOTH axes (the standing requirement)', () => {
  /** Scores that rank well within each asset over time, but identically ACROSS assets at any moment. */
  const timeOnly: Observation[] = [];
  for (let t = 0; t < 40; t++) {
    for (const a of ['A', 'B', 'C', 'D', 'E', 'F']) {
      timeOnly.push({ timestamp: t, asset: a, score: t / 40, outcome: (t > 20 ? 1 : 0) });
    }
  }

  it('catches a model with time-series skill and NO cross-sectional skill', () => {
    const d = discrimination(timeOnly);
    expect(d.perSymbolAuc).toBeCloseTo(1, 6);            // perfect within each asset
    expect(d.withinTimestampAuc).toBeNaN();              // no variation across assets to rank
    expect(d.crossSectionalSpread).toBeCloseTo(0, 10);   // every symbol scores the same
  });

  it('reports real cross-sectional skill when it exists', () => {
    const obs: Observation[] = [];
    for (let t = 0; t < 40; t++) {
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach((a, i) => {
        obs.push({ timestamp: t, asset: a, score: i / 6, outcome: (i >= 3 ? 1 : 0) });
      });
    }
    const d = discrimination(obs);
    expect(d.withinTimestampAuc).toBeCloseTo(1, 6);
    expect(d.crossSectionalSpread).toBeGreaterThan(0);
  });

  it('computes top-decile precision', () => {
    const obs: Observation[] = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i, asset: 'A', score: i / 100, outcome: (i >= 90 ? 1 : 0),
    }));
    expect(discrimination(obs).topDecilePrecision).toBeCloseTo(1, 6);
  });
});

describe('controls', () => {
  const obs: Observation[] = [];
  for (let t = 0; t < 60; t++) {
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach((a, i) => {
      const informative = (i + t) % 6;
      obs.push({ timestamp: t, asset: a, score: informative / 6, outcome: (informative >= 3 ? 1 : 0) });
    });
  }

  it('shuffled timing preserves the score distribution exactly', () => {
    const shuffled = SHUFFLED_TIMING.transform(obs, 1);
    expect(shuffled.map(o => o.score).sort()).toEqual(obs.map(o => o.score).sort());
  });

  it('random labels collapse the signal to chance — the pipeline sanity check', () => {
    const d = discrimination(RANDOM_LABELS.transform(obs, 7));
    expect(Math.abs(d.withinTimestampAuc - 0.5)).toBeLessThan(0.15);
  });

  it('the lag control shifts scores within each asset and drops the burn-in', () => {
    const lagged = lagControl(5).transform(obs, 1);
    expect(lagged.length).toBe(obs.length - 5 * 6);
  });

  it('permutations are deterministic given a seed', () => {
    const a = SHUFFLED_TIMING.transform(obs, 99).map(o => o.score);
    const b = SHUFFLED_TIMING.transform(obs, 99).map(o => o.score);
    expect(a).toEqual(b);
  });

  it('ships shuffled, random-label and lag as mandatory', () => {
    expect(MANDATORY_CONTROLS.map(c => c.id)).toEqual(['shuffled-timing', 'random-labels', 'lag-30']);
  });
});

describe('evaluate (spec §19)', () => {
  const obs: Observation[] = [];
  for (let t = 0; t < 80; t++) {
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach((a, i) => {
      const s = (i + Math.floor(t / 7)) % 6;
      obs.push({ timestamp: t, asset: a, score: s / 6, outcome: (s >= 3 ? 1 : 0) });
    });
  }

  it('reports both axes against every control', () => {
    const r = evaluate({ label: 'test', observations: obs });
    expect(r.controls).toHaveLength(3);
    for (const c of r.controls) {
      expect(c).toHaveProperty('deltaPerSymbolAuc');
      expect(c).toHaveProperty('deltaWithinTimestampAuc');
    }
  });

  it('WARNS when the cross-sectional axis cannot be computed at all', () => {
    const oneAsset: Observation[] = Array.from({ length: 50 }, (_, t) => ({
      timestamp: t, asset: 'A', score: t / 50, outcome: (t > 25 ? 1 : 0),
    }));
    const r = evaluate({ label: 'single-asset', observations: oneAsset });
    expect(r.warnings.join(' ')).toMatch(/ONE axis only/);
  });

  it('sweeps transaction costs rather than reporting one level', () => {
    const returns = Array(200).fill(0.002);
    const weights = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const r = evaluate({ label: 'c', observations: obs, returns, weights });
    expect(r.costSweep?.map(x => x.roundTripPercent)).toEqual([0, 0.10, 0.25]);
    const [free, mid, dear] = r.costSweep!.map(x => x.performance.cagr);
    expect(free).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(dear);
    expect(r.turnoverPerYear).toBeGreaterThan(0);
  });

  it('slices by regime so nothing rests on one episode', () => {
    const r = evaluate({
      label: 'r', observations: obs,
      regimes: { early: { from: 0, to: 39 }, late: { from: 40, to: 79 } },
    });
    expect(Object.keys(r.regimes!)).toEqual(['early', 'late']);
  });

  it('survivesControls demands an edge on BOTH axes', () => {
    // time-series skill only: perfect per-symbol, no cross-sectional information
    const timeOnly: Observation[] = [];
    for (let t = 0; t < 40; t++) {
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach(a => {
        timeOnly.push({ timestamp: t, asset: a, score: t / 40, outcome: (t > 20 ? 1 : 0) });
      });
    }
    const r = evaluate({ label: 'time-only', observations: timeOnly });
    const v = survivesControls(r);
    expect(v.passes).toBe(false);
  });
});
