// Notification envelope precheck (2026-07-11): "don't page the user into an auto-FLAT
// analysis". The precheck builds the REAL prompt and parses its auto_FLAT_active line —
// these tests exercise the parse against genuine buildUserPrompt output (zero-drift by
// construction) and the defer-not-drop suppression transition.
import { describe, it, expect } from 'vitest';
import { parseAutoFlatReasons, nextSuppressionState } from '../src/index';
import { buildUserPrompt, type PromptIndicator } from '../src/prompt';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;

function synthCandles(n: number, startMs: number, stepMs: number, base = 100): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 2 + i * 0.03;
    const open = price, close = base + drift;
    out.push({ time: startMs + i * stepMs, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, volume: 1000 + (i % 7) * 120 });
    price = close;
  }
  return out;
}

function mkIndicators(): PromptIndicator[] {
  const mk = (n: number, step: number, label: string, tf: string) =>
    computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
  return [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')];
}

describe('parseAutoFlatReasons (against real buildUserPrompt output)', () => {
  it('extracts the reasons when the envelope auto-FLATs (calibrated ML below 50)', () => {
    const indicators = mkIndicators();
    (indicators[0] as any).mlWinProbability = 0.72;
    // The calibrated gate keys on calibratedMlWin when present — 0.30 forces the ML auto-FLAT.
    const { prompt } = buildUserPrompt({ symbol: 'BTCUSDT', nowMs: NOW, indicators, calibratedMlWin: 0.30 });
    const reasons = parseAutoFlatReasons(prompt);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some(r => r.startsWith('ML_WIN_'))).toBe(true);
  });

  it('returns [] when no auto_FLAT_active line is present', () => {
    expect(parseAutoFlatReasons('## Bottom Line\nall clear\nConviction Envelope:\n  max_allowed: HIGH')).toEqual([]);
  });

  it('parses a multi-reason line', () => {
    const reasons = parseAutoFlatReasons('Conviction Envelope:\n  auto_FLAT_active: ANY_KILLED=true, macro_IMMINENT, chase_into_extended_aligned_trend\n');
    expect(reasons).toEqual(['ANY_KILLED=true', 'macro_IMMINENT', 'chase_into_extended_aligned_trend']);
  });
});

describe('nextSuppressionState (defer-not-drop)', () => {
  it('fresh cross + envelope flat → suppress, no notification', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: true }))
      .toEqual({ effectiveCross: false, suppressed: true });
  });

  it('fresh cross + envelope clean → notify', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: false }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });

  it('suppressed cross whose envelope clears → DEFERRED notification fires', () => {
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: false }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });

  it('suppressed cross still flat → stays suppressed, still no notification', () => {
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: true }))
      .toEqual({ effectiveCross: false, suppressed: true });
  });

  it('precheck failure fails OPEN (notify) — for a fresh cross and a deferred one', () => {
    expect(nextSuppressionState({ crossed: true, wasSuppressed: false, flat: null }))
      .toEqual({ effectiveCross: true, suppressed: false });
    expect(nextSuppressionState({ crossed: false, wasSuppressed: true, flat: null }))
      .toEqual({ effectiveCross: true, suppressed: false });
  });
});
