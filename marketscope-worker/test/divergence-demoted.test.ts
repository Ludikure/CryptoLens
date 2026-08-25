// Divergence no longer blocks (2026-08-25, envelope-rules.md Part 6 + follow-up).
//
// Twelve variant tests, zero passes: best SHORT lift +0.0028R against a +0.02R bar, and EVERY LONG
// lift negative — `against bias (daily)` blocked bars averaging +0.0504R while keeping +0.0186R.
// The underlying signal is real but worthless: 4H divergence moves P(up24) +2.24pp at p=3.9e-09 and
// does not convert, while DAILY divergence is INVERTED. One indicator, two timeframes, opposite
// signs.
//
// It is still COMPUTED and REPORTED — it is context for the model — but it cannot auto-FLAT.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { systemPrompt } from '../src/prompt';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'src', 'prompt.ts'), 'utf-8');

describe('divergence is context, not a gate', () => {
  it('divergence_escalated_6+_candles can no longer auto-FLAT', () => {
    expect(src).not.toMatch(/autoFlat\.push\('divergence_escalated/);
  });

  it('killDivergence no longer contributes to ANY_KILLED', () => {
    expect(src).toMatch(/const anyKilled = killVolume \|\| killFunding \|\| killMacro;/);
    expect(src).not.toMatch(/const anyKilled = killDivergence/);
  });

  it('the other three kill conditions are UNTOUCHED', () => {
    // Volume and funding are structural; macro guards an exogenous event rather than claiming
    // prediction. A null EV test does not refute a rule that never claimed predictive power.
    expect(src).toMatch(/killVolume/);
    expect(src).toMatch(/killFunding/);
    expect(src).toMatch(/killMacro/);
  });

  it('is absent from EVERY gating structure, not merely tagged inside one', () => {
    // A "does not block" tag under a heading called "Kill Conditions" is weaker governance than
    // not being there. Both the kill-list entry and the `Divergence Escalated` line are gone, and
    // `envDivergenceEscalated` with them — nothing read it once the auto-FLAT was deleted.
    expect(src).not.toMatch(/killParts\.push\(`divergence_against_bias/);
    expect(src).not.toMatch(/L\(`Divergence Escalated/);
    expect(src).not.toMatch(/envDivergenceEscalated =/);
  });

  it('the raw per-timeframe reading STAYS — the indicator block is descriptive', () => {
    // Removing one indicator from a descriptive block because it happens to have been tested,
    // while RSI/MACD/ADX sit there equally untested, would be inconsistent. The prior is governed
    // in the system prompt instead, which addresses the actual risk directly.
    expect(src).toMatch(/Divergence: \$\{ind\.divergence\}/);
  });

  it('the SYSTEM prompt governs the model\'s prior, since the literature disagrees with the data', () => {
    const c = systemPrompt(true), st = systemPrompt(false);
    for (const p of [c, st]) {
      expect(p).toMatch(/RSI DIVERGENCE — CALIBRATION NOTE/);
      expect(p).toMatch(/do NOT cite it as evidence for a direction/i);
      expect(p).toMatch(/~44 bars/);                       // the episode correction, not the bar count
      expect(p).toMatch(/CVD divergence.*different, untested signal/s);
    }
  });
});
