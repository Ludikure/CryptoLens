import { describe, it, expect } from 'vitest';
import { envelopeFor, BIAS } from './helpers/envelope';

// Pre-declared in docs/research/stop-width.md; all five criteria passed, including 10 of 10
// half-year periods spanning the 2022 bear and the 2023-24 bull.
//
// LONG stop floor 2 -> 4 ATR. SHORT unchanged at 2, because it measured FLAT across the sweep and
// there is no case to answer.
describe('the minimum stop distance is direction-dependent', () => {
  const stops = (prompt: string) =>
    [...prompt.matchAll(/^\s*(LONG|SHORT)\s+.*?Entry\s+([\d.]+).*?Stop\s+([\d.]+)/gmi)];

  it('a LONG setup floors its stop at 4 ATR, a SHORT at 2', () => {
    // Read from the SOURCE, because the emitted stop depends on where swing structure happens to
    // sit on the fixture tape — a structural stop wider than the floor legitimately passes through,
    // so asserting on a rendered number would test the fixture rather than the rule.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toMatch(/const minStopDist = atr \* \(effectiveDirection === 'SHORT' \? 2\.0 : 4\.0\)/);
  });

  it('the reward:risk ratio is NOT changed alongside it', () => {
    // The test held R:R fixed at 1.25 — widening the stop widens the target with it. Changing the
    // ratio as well would be a different intervention that was never measured.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).not.toMatch(/tp2Multiple\s*=\s*[\d.]+\s*\*\s*4/);
  });

  it('the prompt still builds end-to-end on both sides', () => {
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      const e = envelopeFor({ ml: 0.80, ...bias });
      expect(e.maxAllowed).toMatch(/FLAT|LOW|MODERATE|HIGH/);
    }
  });
});
