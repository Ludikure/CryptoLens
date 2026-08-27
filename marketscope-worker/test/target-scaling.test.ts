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

  it('the ATR fallback holds its reward:risk instead of collapsing as the stop widens', () => {
    // The fallback was 1.5x ATR against a 2 ATR stop: R:R 0.75 by construction. Whatever the stop
    // width, a fallback TP1 must stay in that neighbourhood — the pre-fix values were 0.18-0.35.
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      for (const row of candidates(envelopeFor({ ml: 0.8, calibratedMl: 0.8, ...bias }).prompt)) {
        if (!row.includes('ATR target')) continue;
        expect(rr(row, 'TP1')).toBeGreaterThanOrEqual(0.5);
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

  it('is a NO-OP at a 2 ATR stop — the width every band was tuned at', () => {
    // The scale is `max(1, stopAtr/2)`, so it is exactly 1.0 at 2 ATR and clamped below it. That is
    // what makes this a units fix rather than a re-tune: stocks (1.5 ATR floor) and every SHORT
    // sitting on its 2 ATR floor keep the behaviour they were tuned with.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toContain('const stopScale = Math.max(1, (risk / Math.max(atr, 0.0001)) / 2.0);');
  });
});
