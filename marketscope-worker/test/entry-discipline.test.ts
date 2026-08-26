// ENTRY DISCIPLINE — RETRACTED 2026-08-25, the same day it shipped.
//
// The rule ("never enter at market; place entries on a 0.2-0.5 ATR pullback") was measured by
// `ml-training/level_entry.py`, which begins its fill window at T+1h. The feature row's `price` is
// the CLOSE of the bar spanning T..T+4h — verified by nearest-match against the hourly klines, where
// offset +3 fits an order of magnitude better than any other — so the simulation placed limit orders
// using price information from inside the bar it then traded through.
//
// Re-run correctly on the same 290,791 opportunities:
//     SHORT  +0.0660R (9/9 periods)  ->  -0.0296R (0/9)   INVERTS
//     LONG   +0.0919R (9/9 periods)  ->  +0.0009R (7/9)   vanishes
//
// These tests now pin the ABSENCE of the rule and the presence of an explicit retraction. A rule
// that measures negative is worse to ship than no rule, and a silent deletion would leave the next
// session free to re-derive it from the vault.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { systemPrompt } from '../src/prompt';
import { promptSource } from './helpers/prompt-source';

const src = () => promptSource;

for (const [label, isCrypto] of [['crypto', true], ['stock', false]] as const) {
  describe(`entry method — ${label}`, () => {
    const p = systemPrompt(isCrypto);

    it('no longer claims a measured entry rule', () => {
      expect(p).not.toMatch(/ENTRY DISCIPLINE/);
      expect(p).not.toMatch(/NEVER place an entry at the current price/);
      expect(p).not.toMatch(/0\.062R/);
      expect(p).not.toMatch(/40-60x/);
      expect(p).not.toMatch(/vanishes on longs/);   // the retraction's OWN false claim, corrected 2026-08-26
    });

    it('says plainly that the numbers were withdrawn, and why', () => {
      expect(p).toMatch(/ENTRY METHOD — RETRACTED/);
      expect(p).toMatch(/4-hour lookahead/);
      expect(p).toMatch(/on SHORTS the effect inverts/);
      expect(p).toMatch(/hand-computed three times with three different answers/);
    });

    it('forbids the model citing entry numbers that no longer exist', () => {
      expect(p).toMatch(/NO ENTRY-METHOD RULE IS IN FORCE/);
      expect(p).toMatch(/do NOT cite pullback-vs-market numbers as support/);
    });
  });
}

describe('the computed pullback band is gone with the rule it enforced', () => {
  it('no longer emits a band', () => {
    expect(src()).not.toMatch(/SHALLOW PULLBACK BAND \(the measured entry zone/);
    expect(src()).not.toMatch(/entryPx - 0\.5 \* entryAtr/);
  });

  it('leaves a retraction marker rather than a silent deletion', () => {
    expect(src()).toMatch(/SHALLOW PULLBACK BAND — REMOVED 2026-08-25/);
  });
});

// Part 10 removed the chase auto-FLAT partly on the reasoning that ENTRY DISCIPLINE already forbade
// chasing. That premise is now retracted, so the removal is UNSUPPORTED — but it is not thereby
// wrong, and re-adding a gate whose own evidence is also broken (its `stretch` term read up to 20h
// of future price) would not be an improvement. These record the current state; the re-test is
// tracked in envelope-rules.md.
describe('the chase reading is still context, not a gate (Part 10, now unsupported)', () => {
  it('chase HIGH does not auto-FLAT', () => {
    expect(src()).not.toMatch(/autoFlat\.push\('chase_into_extended_aligned_trend'\)/);
  });

  it('keeps the loud CHASE / EXHAUSTION reading', () => {
    expect(src()).toMatch(/CHASE \/ EXHAUSTION RISK: \$\{chaseLevel\}/);
  });

  it('keeps chaseUnguarded on the MIXED mandate', () => {
    expect(src()).toMatch(/const chaseUnguarded = envChaseLevel === 'HIGH';/);
  });
});

describe('the two ATR units are still never confusable', () => {
  it('labels level distances as 1H-ATR rather than a bare "ATR"', () => {
    expect(src()).toMatch(/x 1H-ATR from live/);
  });
});
