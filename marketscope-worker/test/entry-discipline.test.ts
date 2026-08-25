// Entry discipline reaches the model (2026-08-25, Parts 4-5).
//
// Parts 1-3 found no gate that generalised; Part 4 found the value was in the ENTRY LEVEL all along
// (+0.062R on a shallow pullback vs -0.004R at market vs -0.129R chasing, 9/9 periods); Part 5 found
// a SHALLOW mechanical pullback beats a structural swing level, because fill rate dominates.
//
// This pins the guidance because the 2026-08-22 lesson was that an input without an output
// instruction is a silent no-op — and here the instruction IS the whole change.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { systemPrompt } from '../src/prompt';

for (const [label, isCrypto] of [['crypto', true], ['stock', false]] as const) {
  describe(`entry discipline — ${label}`, () => {
    const p = systemPrompt(isCrypto);

    it('states it is the highest-value decision, not one risk among many', () => {
      expect(p).toMatch(/ENTRY DISCIPLINE — THE HIGHEST-VALUE DECISION/);
      expect(p).toMatch(/40-60x anything the conviction gates contribute/);
    });

    it('forbids a market entry outright', () => {
      expect(p).toMatch(/NEVER place an entry at the current price/);
      expect(p).toMatch(/the correct output is NO SETUP/);
    });

    it('says SHALLOW, and says why deep structural levels are worse', () => {
      // The counter-intuitive half: "wait for a significant level" sounds disciplined and measures
      // worse, because a rejected price needs a situation-changing move to reach again.
      expect(p).toMatch(/SHALLOW pullback/);
      expect(p).toMatch(/Deeper is NOT safer/);
      expect(p).toMatch(/fill only a quarter as often/);
    });

    it('frames an unfilled setup as a success, so the model does not widen toward price', () => {
      expect(p).toMatch(/unfilled setup is a SUCCESS/);
      expect(p).toMatch(/converts the \+0\.062R arm into the -0\.129R one/);
    });

    it('carries the measured numbers rather than an assertion', () => {
      expect(p).toMatch(/-0\.004R \(short\)/);
      expect(p).toMatch(/9 of 9 periods/);
      expect(p).toMatch(/0 of 9 periods/);
    });
  });
}

// The rule is stated in ATR; every entry the model writes is a price. A live BTC analysis (2026-08-25,
// price $79,114, 4H ATR ~$609) proposed a pullback zone of $78,888-$78,514 — 0.37 ATR to 0.99 ATR.
// The lower bound was twice the measured maximum, and it was a named 1H support: exactly the "deep
// significant level" rule 2 forbids. Computing the band removes the step where it went wrong.
describe('the shallow pullback band is computed, not left as an ATR conversion', () => {
  it('emits explicit LONG and SHORT price bands with the 4H ATR', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toMatch(/SHALLOW PULLBACK BAND \(the measured entry zone, computed — do not re-derive\)/);
    expect(src).toMatch(/entryPx - 0\.5 \* entryAtr/);
    expect(src).toMatch(/entryPx - 0\.2 \* entryAtr/);
    expect(src).toMatch(/entryPx \+ 0\.2 \* entryAtr/);
    expect(src).toMatch(/entryPx \+ 0\.5 \* entryAtr/);
  });

  it('anchors the band to the LIVE price, not the stale closed bar', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toMatch(/const entryPx = \(input\.livePrice != null && input\.livePrice > 0\) \? input\.livePrice : fourH\.price;/);
  });

  it('tells the model to prefer the band over a distant "significant" level', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');
    expect(src).toMatch(/use the band, not the level/);
    expect(src).toMatch(/Deeper is NOT safer/);
  });
});
