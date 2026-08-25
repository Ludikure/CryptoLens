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

  it('bands at the validated 0.30 / 0.50 thresholds', () => {
    expect(promptWithCrash(0.20)).toMatch(/Crash Risk: LOW/);
    expect(promptWithCrash(0.40)).toMatch(/Crash Risk: ELEVATED/);
    expect(promptWithCrash(0.62)).toMatch(/Crash Risk: HIGH/);
  });

  it('always ships the EPISODIC caveat with the number', () => {
    // A gauge that fires twice then misses a 25% fall reads as broken unless it says so itself.
    for (const p of [0.20, 0.40, 0.62]) {
      expect(promptWithCrash(p)).toMatch(/EPISODIC/);
      expect(promptWithCrash(p)).toMatch(/LOW is "no warning", NOT "safe"/);
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
