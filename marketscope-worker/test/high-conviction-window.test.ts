// Must-offer-entry rule (2026-08-21). During the Aug-2026 62k→80k BTC run every quantitative
// gate was open — replayed over the real tape: 34/34 4H bars envelope-CLEAN at ML 80 — yet the
// analyses declined to construct any setup and the app read "stay put" through a +25% move.
// The HIGH_CONVICTION_WINDOW directive makes a concrete setup mandatory in that state.
// Fixture = the real BTCUSDT tape (daily/4H/1H closed candles captured 2026-08-21).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../src/indicators-full';
import { buildUserPrompt, systemPrompt, type PromptIndicator } from '../src/prompt';
import { parseAutoFlatReasons } from '../src/index';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
const nowMs = fx.fourH[fx.fourH.length - 1].time + 14400e3;

function promptAtMl(ml: number) {
  const indicators: PromptIndicator[] = [
    computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator,
  ];
  (indicators[0] as any).mlWinProbability = ml;
  return buildUserPrompt({ symbol: 'BTCUSDT', nowMs, indicators, prevState: {}, economicEvents: [], calibratedMlWin: ml } as any).prompt;
}

describe('HIGH_CONVICTION_WINDOW (must-offer-entry rule)', () => {
  it('fires on the real Aug-2026 rally tape at ML 80: aligned, clean envelope, setup mandatory', () => {
    const prompt = promptAtMl(0.80);
    expect(parseAutoFlatReasons(prompt)).toEqual([]);   // pins the replay: envelope CLEAN
    expect(prompt).toContain('HIGH_CONVICTION_WINDOW');
    expect(prompt).toContain('LONG setup is MANDATORY');
    expect(prompt).not.toContain('MIXED_HIGH_ML_WINDOW');   // aligned, not mixed
  });

  it('does not fire below the 70 window', () => {
    const prompt = promptAtMl(0.55);
    expect(prompt).not.toContain('HIGH_CONVICTION_WINDOW');
  });

  it('system prompt (both markets) carries the setup-mandatory reinforcement', () => {
    for (const p of [systemPrompt(true), systemPrompt(false)]) {
      expect(p).toContain('HIGH_CONVICTION_WINDOW');
      expect(p).toContain('NOT an acceptable output inside those windows');
    }
  });
});
