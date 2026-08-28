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
    expect(src).toMatch(/minStopMultiple = effectiveDirection === 'SHORT' \? 2\.0 : 4\.0/);
    expect(src).toMatch(/minStopDist = atr \* minStopMultiple/);
  });

  it('the reward:risk ratio is NOT changed alongside it', () => {
    // The test held R:R fixed at 1.25 — widening the stop widens the target with it. Changing the
    // ratio as well would be a different intervention that was never measured.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    // `tp2Multiple` has NEVER existed in prompt.ts (`git log -S` is empty), so this assertion
    // passed unconditionally and could not observe the invariant it is named for — a change that
    // moved non-wideBand TP2 from 1.25R to 2.5R went green through it. Pin the actual fallback
    // ratios instead, which are now named constants rather than ATR multiples.
    expect(src).toMatch(/const fallbackTP2R = \(isWideBand && isCrypto\) \? 1\.5 : 1\.25;/);
    expect(src).toMatch(/const fallbackTP1R = isWideBand \? 0\.75 : isCounterTrend \? 0\.75 : 0\.6;/);
  });

  it('the prompt still builds end-to-end on both sides', () => {
    for (const bias of [BIAS.alignedBullish, BIAS.alignedBearish]) {
      const e = envelopeFor({ ml: 0.80, ...bias });
      expect(e.maxAllowed).toMatch(/FLAT|LOW|MODERATE|HIGH/);
    }
  });
});
