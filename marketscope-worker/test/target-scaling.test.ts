import { describe, it, expect } from 'vitest';
import { envelopeFor, BIAS } from './helpers/envelope';

/**
 * TARGETS MUST SCALE WITH THE STOP — the half of the 2026-08-26 stop-width change that did not ship.
 *
 * `stop-width.md:44` states the tested intervention exactly: "The reward:risk ratio is NOT changed —
 * widening the stop widens the target with it, which is what was tested." The floor went to 4 ATR on
 * LONG; the target bands and ATR fallbacks stayed at absolute ATR distances tuned for a 2 ATR stop.
 *
 * That is not a marginal miscalibration. `viable` requires TP1 R:R >= 0.5 and every TP1 band caps
 * distance at 2.0 ATR, so TP1 R:R <= 2/stopAtr — at a 4 ATR floor, <= 0.5 exactly. Since
 * `prompt-system.json` says "Emit a setup ONLY if a Viable risk-defined level exists", ordinary LONG
 * setups became unemittable.
 *
 * These tests pin the INVARIANT rather than the numbers, so a future band re-tune cannot silently
 * reintroduce it.
 */
function candidates(prompt: string): string[] {
  return prompt.split('\n').filter(l => l.startsWith('[TREND]') || l.startsWith('[COUNTER-TREND]'));
}
const viable = (row: string) => /Viable: true\s*$/.test(row.trim());
const rr = (row: string, which: 'TP1' | 'TP2') =>
  Number(new RegExp(`${which}:[^|]*R:R=([0-9.]+)`).exec(row)?.[1] ?? NaN);

describe('targets scale with the stop', () => {
  it('a LONG setup is emittable at all — it was not, on 3 of 3 real candidates', () => {
    const rows = candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, ...BIAS.alignedBullish }).prompt);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(viable)).toBe(true);
  });

  it('SHORT still produces viable candidates', () => {
    const rows = candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, ...BIAS.alignedBearish }).prompt);
    expect(rows.some(viable)).toBe(true);
  });

  // Every branch, at its OWN bar. Asserting 0.5 everywhere was 2x loose on non-wideBand and 1.6x
  // on counter-trend, so a row reporting `Viable: false` passed it green.
  const SYMS: Array<[string, number]> = [['BTCUSDT', 0.5], ['TIAUSDT', 1.0]];

  it('a fallback TP1 clears the viability bar of ITS OWN branch, at every stop width', () => {
    for (const [symbol, floor] of SYMS) {
      for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
        for (const row of candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, symbol, ...bias }).prompt)) {
          expect(rr(row, 'TP1')).toBeGreaterThanOrEqual(floor);
          expect(row).toContain('Viable: true');
        }
      }
    }
  });

  it('TP1 and TP2 are never the same price', () => {
    // They were. `tp2MinRR` derived from a `tp1RR` that was 0 whenever no LEVEL qualified — always,
    // on the non-wideBand path — so the fallback TP1 landed inside TP2's admissible zone and both
    // anti-collision guards degraded to comparing against the entry. Measured on the real fixture:
    // `TP1: $72,330.00 … TP2: $72,330.00 … Viable: true`, one price on two rungs.
    const px = (row: string, which: 'TP1' | 'TP2') =>
      new RegExp(`${which}: \\$([\\d,]+\\.?\\d*)`).exec(row)?.[1];
    for (const [symbol] of SYMS) {
      for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
        for (const row of candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, symbol, ...bias }).prompt)) {
          expect(px(row, 'TP2')).not.toBe(px(row, 'TP1'));
          expect(rr(row, 'TP2')).toBeGreaterThan(rr(row, 'TP1'));
        }
      }
    }
  });

  it('TP2 stays beyond TP1 on every candidate', () => {
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      for (const row of candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, ...bias }).prompt)) {
        expect(rr(row, 'TP2')).toBeGreaterThan(rr(row, 'TP1'));
      }
    }
  });

  it('the fallback target satisfies its own R:R band, at whatever the stop turns out to be', () => {
    // The property that makes the whole class of defect impossible, asserted as a property rather
    // than as a formula. An ATR-multiple fallback can miss the R:R band it is judged against — that
    // is how non-wideBand ended up placing TP1 at 1.2 ATR while demanding R:R >= 1.0, unsatisfiable
    // at BOTH the 4 ATR floor and the old 2 ATR one. An R-anchored fallback cannot.
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      for (const row of candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, ...bias }).prompt)) {
        if (!row.includes('R)')) continue;              // fallback rows are labelled in R
        expect(rr(row, 'TP1')).toBeGreaterThanOrEqual(0.5);
        expect(rr(row, 'TP2')).toBeGreaterThan(rr(row, 'TP1'));
      }
    }
  });

  it('a trendingSymbol — the non-wideBand path — can emit a setup at all', () => {
    // TIAUSDT is on the `trendingSymbols` whitelist, so it takes tp1RRBand [1.0,1.7] with a 1.2 ATR
    // fallback. Six of six candidates reported `Viable: false` before this, at every stop width,
    // which made the 18 whitelisted symbols silently unemittable — including NVDA, COIN and GLD.
    const rows = candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, symbol: 'TIAUSDT',
                                         ...BIAS.alignedBullish }).prompt);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(viable)).toBe(true);
  });
});
