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

// This prompt carries THREE quantities called "ATR" — daily, 4H and 1H, ~2x apart. TAGGED LEVELS
// and CANDIDATE SETUPS use the 1H ATR (`atrForRR`); the SHALLOW PULLBACK BAND uses the 4H ATR,
// because that is the unit Parts 4-5 measured in (`atrPercent` is 4H). Both are right for their
// purpose; the collision is only in the name. On 2026-08-25 it made me read a compliant 0.50-ATR
// entry as a 0.99-ATR violation, so the units are now spelled out.
describe('the two ATR units are never confusable', () => {
  const src = () => readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');

  it('labels level distances as 1H-ATR rather than a bare "ATR"', () => {
    expect(src()).toMatch(/x 1H-ATR from live/);
    expect(src()).not.toMatch(/\{f\(level\.atrDistance, 1\)\}x ATR from live/);
  });

  it('tells the model to compare PRICES, never to convert between the two units', () => {
    expect(src()).toMatch(/NEVER convert between them/);
    expect(src()).toMatch(/compare .*its PRICE against the band's PRICES/s);
  });

  it('the band still names its own unit', () => {
    expect(src()).toMatch(/\(4H ATR \$\{formatPrice\(entryAtr\)\}\)/);
  });
});

// Part 10: the chase guard was rehabilitated in Part 4 for defending the CHASING arm
// (-0.129R/-0.195R, 0/9). That still holds and is now moot -- ENTRY DISCIPLINE forbids chasing
// outright, so the guard defended a move the app can no longer make while blocking 27% of bars.
// As a bar filter on 274,079 opportunities it was noise in all four cells and INVERTED on LONG in
// the robust arm. The READING stays, the GATE goes -- same treatment as divergence in Part 6.
describe('the chase reading is context, not a gate (Part 10)', () => {
  const src = () => readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');

  it('chase HIGH can no longer auto-FLAT', () => {
    expect(src()).not.toMatch(/autoFlat\.push\('chase_into_extended_aligned_trend'\)/);
  });

  it('keeps the loud CHASE / EXHAUSTION reading and its pullback directive', () => {
    expect(src()).toMatch(/CHASE \/ EXHAUSTION RISK: \$\{chaseLevel\}/);
    expect(src()).toMatch(/prefer a pullback entry over the current extreme/);
  });

  it('the catalyst framing keys on the READING, not on a FLAT that can never fire', () => {
    // It used to test autoFlat.includes('chase_...'), which is now permanently false — a dead
    // branch that reads as live governance, the conformal_abstain shape.
    expect(src()).not.toMatch(/autoFlat\.includes\('chase_into_extended_aligned_trend'\)/);
    expect(src()).toMatch(/input\.news\?\.catalystActive && envChaseLevel === 'HIGH'/);
  });

  it('the catalyst framing no longer orders a NO SETUP', () => {
    // On an extended bar the correct output is a conditional entry at the band, not silence.
    expect(src()).not.toMatch(/Still output NO SETUP — but name the catalyst/);
    expect(src()).toMatch(/Set the conditional entry at the band and accept that it may never fill/);
  });

  it('keeps chaseUnguarded on the MIXED mandate — a different question, untested', () => {
    // Part 10 tested the reading as a bar FILTER, not as a suppressor of a rule that FORBIDS
    // declining. Leaving a conservative brake on forced output is cheap; removing it on an
    // untested inference is not.
    expect(src()).toMatch(/const chaseUnguarded = envChaseLevel === 'HIGH';/);
  });
});
