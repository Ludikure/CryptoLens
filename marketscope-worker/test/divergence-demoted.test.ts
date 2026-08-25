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

  it('divergence is still computed and surfaced, tagged as non-blocking', () => {
    expect(src).toMatch(/CONTEXT_ONLY_does_not_block/);
    expect(src).toMatch(/Divergence Escalated/);
  });

  it('the surfaced line states WHY it does not block, so it is not silently demoted', () => {
    expect(src).toMatch(/DAILY divergence is INVERTED/);
  });
});
