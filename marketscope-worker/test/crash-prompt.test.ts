// The crash model reaches the LLM (2026-08-24).
//
// This test exists because of a specific past failure: on 2026-08-22 news headlines were added to
// the USER prompt while the SYSTEM prompt was left untouched, so the model received an input it had
// no instruction to use and correctly said nothing about it. "Adding an input is half a change."
// These assertions pin BOTH halves — the line in the user prompt AND the contract in the system
// prompt — so the pair cannot drift apart silently again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../src/indicators-full';
import { buildUserPrompt, systemPrompt, type PromptIndicator } from '../src/prompt';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
const nowMs = fx.fourH[fx.fourH.length - 1].time + 14400e3;

function promptWithCrash(crash: number | null) {
  const indicators: PromptIndicator[] = [
    computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator,
  ];
  (indicators[0] as any).mlWinProbability = 0.65;
  (indicators[0] as any).mlCrashProb = crash;
  return buildUserPrompt({ symbol: 'BTCUSDT', nowMs, indicators, prevState: {},
                           economicEvents: [], calibratedMlWin: 0.65 } as any).prompt;
}

describe('crash risk reaches the model — input AND output contract', () => {
  it('emits a Crash Risk line on the real tape when the model has a reading', () => {
    const p = promptWithCrash(0.62);
    expect(p).toMatch(/Crash Risk: HIGH/);
    expect(p).toMatch(/62% chance of a >=10% fall within 10 days/);
  });

  it('bands against the 41% BASE RATE, not against the sizing curve', () => {
    // REGRESSION 2026-08-25. This line used to band on the SIZING curve's 0.30/0.50 breakpoints,
    // so 0.39 — BELOW the 41% base rate — printed "Crash Risk: ELEVATED ... raise the bar for a new
    // entry", a sentence that reports a below-average day and calls it elevated. A live BTC
    // analysis shipped exactly that. Same defect as the six spurious card warnings fixed in
    // crash.ts on 2026-08-24; the fix had never been propagated to the prompt.
    expect(promptWithCrash(0.39)).toMatch(/Crash Risk: ORDINARY/);
    expect(promptWithCrash(0.39)).not.toMatch(/Crash Risk: ELEVATED/);
    expect(promptWithCrash(0.20)).toMatch(/Crash Risk: ORDINARY/);
    expect(promptWithCrash(0.50)).toMatch(/Crash Risk: ELEVATED/);   // base + 0.08
    expect(promptWithCrash(0.62)).toMatch(/Crash Risk: HIGH/);       // base + 0.18
  });

  it('says which side of the base rate the reading falls on', () => {
    expect(promptWithCrash(0.39)).toMatch(/2pp BELOW the 41% base rate/);
    expect(promptWithCrash(0.62)).toMatch(/21pp ABOVE the 41% base rate/);
  });

  it('reports the size cut without dressing it as a warning', () => {
    // Both facts are true at 39%: the validated T8 arm-D curve halves size above 0.30, AND 39% is
    // an unremarkable reading. The curve is the measured finding and stays; only the label changed.
    const p = promptWithCrash(0.39);
    expect(p).toMatch(/halves size here \(validated at 0\.30, which sits below the base rate/);
    expect(p).toMatch(/NOT a reason to raise the bar on an entry/);
  });

  it('always ships the EPISODIC caveat with the number', () => {
    // A gauge that fires twice then misses a 25% fall reads as broken unless it says so itself.
    for (const p of [0.20, 0.40, 0.62]) {
      expect(promptWithCrash(p)).toMatch(/EPISODIC/);
      expect(promptWithCrash(p)).toMatch(/ORDINARY is "no warning", NOT "safe"/);
    }
  });

  it('states it is about drawdown, NOT direction — a high reading is not a short signal', () => {
    expect(promptWithCrash(0.62)).toMatch(/about DRAWDOWN, not direction/);
    expect(promptWithCrash(0.62)).toMatch(/not a SHORT signal/);
  });

  it('omits the line entirely when there is no reading, rather than implying LOW', () => {
    expect(promptWithCrash(null)).not.toMatch(/Crash Risk:/);
  });

  it('SYSTEM prompt tells the model what to do with it — the half that was missed for news', () => {
    expect(systemPrompt(true)).toMatch(/CRASH RISK/);
    expect(systemPrompt(true)).toMatch(/NOT a safety signal/);
    expect(systemPrompt(true)).toMatch(/say NOTHING about it/);
  });

  it('tells the STOCK prompt the model is absent, so silence is not read as LOW', () => {
    expect(systemPrompt(false)).toMatch(/CRYPTO-ONLY/);
    expect(systemPrompt(false)).toMatch(/absence carries no information/);
  });
});
