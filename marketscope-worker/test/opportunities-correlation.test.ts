// Regression tests for three placeholders that shipped inert (2026-08-24).
//
// The correlation one is the reason these exist: passing `{}` made `effectiveBets` compute
// n/(1+(n-1)*0) = n, so a book of five correlated crypto positions reported "5 independent bets".
// T7 measured crypto rho-bar at 0.62, which makes five positions about 1.5 — so the card was
// asserting the exact opposite of the thing it was built to warn about. A wrong number on screen is
// worse than a missing one, hence a test rather than a comment.
import { describe, it, expect } from 'vitest';
import { effectiveBets } from '../src/trading/portfolio';
import { correlatedExposure, DEFAULT_LIMITS } from '../src/trading/sizing';

const uncorrelated = { A: { B: 0.1, C: 0.1 }, B: { A: 0.1, C: 0.1 }, C: { A: 0.1, B: 0.1 } };
const crypto = { A: { B: 0.62, C: 0.62 }, B: { A: 0.62, C: 0.62 }, C: { A: 0.62, B: 0.62 } };

describe('correlation must not be inert', () => {
  it('EMPTY correlations report every position as independent — the bug', () => {
    // Pinned deliberately: this is what the endpoint was doing, so the fix is visible as a change.
    expect(effectiveBets(['A', 'B', 'C'], {})).toBe(3);
  });

  it('at the measured crypto rho-bar of 0.62, three positions are ~1.4 bets, not 3', () => {
    const n = effectiveBets(['A', 'B', 'C'], crypto);
    expect(n).toBeGreaterThan(1.3);
    expect(n).toBeLessThan(1.5);
  });

  it('uncorrelated assets stay close to their headcount', () => {
    expect(effectiveBets(['A', 'B', 'C'], uncorrelated)).toBeGreaterThan(2.4);
  });

  it('the correlated-exposure limit cannot bind at all with empty correlations', () => {
    const openNotionalByAsset = { B: 0.3, C: 0.3 };
    const tight = { A: { B: 0.85, C: 0.85 }, B: {}, C: {} };
    const empty = correlatedExposure('A', { equity: 1, openNotionalByAsset, correlations: {} },
                                     DEFAULT_LIMITS.correlationThreshold);
    const real = correlatedExposure('A', { equity: 1, openNotionalByAsset, correlations: tight },
                                    DEFAULT_LIMITS.correlationThreshold);
    expect(empty).toBe(0);            // the bug: nothing counted, ever
    expect(real).toBeCloseTo(0.6, 6); // both correlated positions counted against the limit
  });

  it('DOCUMENTS a design mismatch: the 0.70 threshold does NOT bind at crypto rho-bar 0.62', () => {
    // Not a bug, but it must be a conscious choice rather than an accident. The hard limit fires
    // only on unusually tight PAIRS; typical crypto correlation slips under it. The broad warning
    // therefore comes from `effectiveBets`, which uses the actual correlations and correctly
    // reports ~1.4 bets for three positions — that is the number the user must see.
    const openNotionalByAsset = { B: 0.3, C: 0.3 };
    const atCryptoAverage = correlatedExposure(
      'A', { equity: 1, openNotionalByAsset, correlations: crypto }, DEFAULT_LIMITS.correlationThreshold);
    expect(DEFAULT_LIMITS.correlationThreshold).toBe(0.70);
    expect(atCryptoAverage).toBe(0);                       // 0.62 < 0.70 -> does not count
    expect(effectiveBets(['A', 'B', 'C'], crypto)).toBeLessThan(1.5);  // but the warning still fires
  });
});

// QUARANTINE (2026-08-26). The excursion model's labels and base curve both come from
// `excursion_dataset.pkl.gz`, built on the retracted 4h-lookahead anchor. It reaches neither the
// prompt nor the app — only `/opportunities` — so it is flagged rather than removed, and the flag
// must survive until the retrain.
describe('the excursion model declares its contamination', () => {
  it('excursionModelInfo carries the quarantine flag and a usable note', async () => {
    const { excursionModelInfo } = await import('../src/trading/excursion');
    const info = excursionModelInfo() as Record<string, unknown>;
    expect(info.contaminated).toBe(true);
    expect(String(info.contaminationNote)).toMatch(/4h-lookahead anchor/);
    expect(String(info.contaminationNote)).toMatch(/Do not use for sizing or EV until retrained/);
  });

  it('names the base curve as sharing the defect, so it is not treated as a clean fallback', async () => {
    const { excursionModelInfo } = await import('../src/trading/excursion');
    expect(String((excursionModelInfo() as Record<string, unknown>).contaminationNote))
      .toMatch(/base curve shares the defect/);
  });
});
