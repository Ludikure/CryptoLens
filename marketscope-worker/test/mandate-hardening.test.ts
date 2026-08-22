// Hardening of the must-offer-entry mandate (2026-08-21b), from the max-effort review of 30d7303.
// Each block pins one finding: the windows must survive a compressed calibration curve, must reach
// the pullback bars they name as the entry, must NOT compel a setup where forcing one is wrong
// (earnings gap, blind data, unguarded MIXED states), and the machine-readable contract must carry
// the mandate so a prose-only answer can't read downstream as "no setup".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeFullIndicators } from '../src/indicators-full';
import { buildUserPrompt, systemPrompt, type PromptIndicator } from '../src/prompt';
import { entryReached } from '../src/outcome-tracking';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'));
const nowMs = fx.fourH[fx.fourH.length - 1].time + 14400e3;

function build(over: Record<string, any> = {}, tfs: { daily?: any[]; fourH?: any[]; oneH?: any[] } = {}) {
  const ind: PromptIndicator[] = [
    computeFullIndicators(tfs.daily ?? fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(tfs.fourH ?? fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
    computeFullIndicators(tfs.oneH ?? fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as unknown as PromptIndicator,
  ];
  (ind[0] as any).mlWinProbability = over.ml ?? 0.80;
  return buildUserPrompt({
    symbol: 'BTCUSDT', nowMs, indicators: ind, prevState: {}, economicEvents: [],
    calibratedMlWin: over.ml ?? 0.80, calibrationCeiling: over.ceiling, ...over.extra,
  } as any).prompt;
}

describe('mandate window — calibration ceiling', () => {
  it('stays reachable when the live curve tops out below 70 (the clamp would otherwise kill it)', () => {
    // Ceiling 0.69: no bar in the universe can be calibrated above 69, so a hard 70 gate would
    // make the window unreachable everywhere — the silent-death case the review flagged.
    const p = build({ ml: 0.69, ceiling: 0.69 });
    expect(p).toContain('HIGH_CONVICTION_WINDOW');
    expect(p).toContain('>= 69');
  });

  it('never floors below the notify threshold (65) even on a badly compressed curve', () => {
    const p = build({ ml: 0.64, ceiling: 0.50 });
    expect(p).not.toContain('HIGH_CONVICTION_WINDOW');       // 64 < the 65 floor
    expect(build({ ml: 0.66, ceiling: 0.50 })).toContain('HIGH_CONVICTION_WINDOW');
  });

  it('falls back to a 70 gate when no curve could be fitted', () => {
    expect(build({ ml: 0.69, ceiling: null })).not.toContain('HIGH_CONVICTION_WINDOW');
    expect(build({ ml: 0.71, ceiling: null })).toContain('HIGH_CONVICTION_WINDOW');
  });
});

describe('mandate window — suspension instead of a forced blind entry', () => {
  it('suspends (not mandates) when 2+ enrichment sources are stale', () => {
    // The missing feeds are exactly the ones whose signals would CLOSE the window, so a forced
    // entry there is the blindest possible read.
    const p = build({ ml: 0.80, extra: { dataQuality: { missingEnrichments: ['derivatives', 'positioning'] } } });
    expect(p).toContain('HIGH_CONVICTION_WINDOW_SUSPENDED');
    expect(p).not.toContain('setup is MANDATORY');
  });
});

describe('mandate window — pullback bars are IN the window', () => {
  it('fires on ALIGNED_*_HIGHER_TF_ONLY and names the 1H pullback as the entry', () => {
    // Daily+4H aligned bullish with the 1H counter — the retest bar the remedy points at, which
    // the strict-equality check previously excluded. The 1H bias is overridden directly so the
    // state is exercised deterministically rather than hoping synthetic candles produce it.
    const ind: PromptIndicator[] = [
      computeFullIndicators(fx.daily, { timeframe: '1d', label: 'Daily', isCrypto: true }) as unknown as PromptIndicator,
      computeFullIndicators(fx.fourH, { timeframe: '4h', label: '4H', isCrypto: true }) as unknown as PromptIndicator,
      { ...(computeFullIndicators(fx.oneH, { timeframe: '1h', label: '1H', isCrypto: true }) as any), bias: 'Bearish' } as unknown as PromptIndicator,
    ];
    (ind[0] as any).mlWinProbability = 0.80;
    const p = buildUserPrompt({ symbol: 'BTCUSDT', nowMs, indicators: ind, prevState: {}, economicEvents: [], calibratedMlWin: 0.80 } as any).prompt;
    expect(p).toContain('ALIGNED_BULLISH_HIGHER_TF_ONLY');   // the state under test really is active
    expect(p).toContain('HIGH_CONVICTION_WINDOW');
    expect(p).toContain('that IS the pullback');
    expect(p).toContain('LONG setup is MANDATORY');
  });
});

describe('system prompt — the machine-readable contract carries the mandate', () => {
  it('both markets: the JSON block must contain the mandated setup, not an empty array', () => {
    for (const s of [systemPrompt(true), systemPrompt(false)]) {
      expect(s).toContain('EXCEPTION —');
      expect(s).toContain('the array MUST contain the setup you described in the prose');
      expect(s).toContain('this section is REQUIRED');       // "If You Take a Position" un-gated inside a window
    }
  });

  it('no fused token from the splice (regression: "The`max_allowed`")', () => {
    for (const s of [systemPrompt(true), systemPrompt(false)]) {
      expect(s).not.toContain('The`max_allowed`');
      expect(s).toContain('The `max_allowed`');
    }
  });
});

describe('entryReached — breakout conditionals must not false-fire', () => {
  const bar = (high: number, low: number) => ({ high, low });
  it('LONG breakout (entry above setup price) needs price to RISE to it', () => {
    expect(entryReached(bar(102.9, 99.5), 103, 100, true)).toBe(false);   // the phantom-loss case
    expect(entryReached(bar(103.2, 99.5), 103, 100, true)).toBe(true);
  });
  it('SHORT breakdown (entry below setup price) needs price to FALL to it', () => {
    expect(entryReached(bar(100.5, 97.2), 97, 100, false)).toBe(false);
    expect(entryReached(bar(100.5, 96.8), 97, 100, false)).toBe(true);
  });
  it('pullback forms keep their original semantics', () => {
    expect(entryReached(bar(106, 99), 98, 100, true)).toBe(false);
    expect(entryReached(bar(101, 97.9), 98, 100, true)).toBe(true);
  });
  it('market entry (within 0.1%) counts immediately; legacy rows fall back to direction', () => {
    expect(entryReached(bar(101, 99.8), 100, 100, true)).toBe(true);
    expect(entryReached(bar(102, 99.9), 100, 0, true)).toBe(true);
  });
});
