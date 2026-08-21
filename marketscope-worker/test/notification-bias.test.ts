// Notification direction gate on the faithful scorer (2026-08-21). Regression for the missed
// Aug-2026 62k→80k BTC run: the simplified computeScore (scoring.ts) penalizes RSI>70 by 3
// points against crypto's +1 price-position weight, so it scored the +7% breakout day (Aug 19,
// RSI 74) as daily-BEARISH and the follow-through (RSI 84) as Neutral — direction gate closed
// for the entire move. The gate now uses computeFullIndicators (scoring-ios), which is what
// /indicators shows the user; on this exact tape it reads Daily Bullish / 4H Strong Bullish.
// Fixture: real BTCUSDT closed candles captured 2026-08-21 (daily last close 08-20, 4H last
// close 08-21 12:00Z — the tape /indicators scored live that day).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { notificationBiasAlignment } from '../src/index';
import { computeScore } from '../src/scoring';

interface Fx { daily: any[]; fourH: any[] }
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8')) as Fx;

describe('notificationBiasAlignment (faithful scorer)', () => {
  it('reads the real Aug-2026 BTC breakout as aligned_bullish', () => {
    expect(notificationBiasAlignment(fx.daily, fx.fourH, true)).toBe('aligned_bullish');
  });

  it('documents the old scorer failure this replaces: simplified daily bias is NOT bullish on the same tape', () => {
    // Not a behavior we depend on — recorded so a future "simplify the gate again" attempt
    // trips over the exact tape that burned us. RSI 84 → −3 vs price-position +1.
    const simplified = computeScore(fx.daily as any, true);
    expect(simplified.bias).not.toContain('Bullish');
  });

  it('reads a persistent downtrend as aligned_bearish', () => {
    // Gentle steady decline: stack bearish, price below all EMAs, structure down, RSI ~40s
    // (below the bearish-regime penalty zone — the read comes from trend geometry, not RSI).
    const mk = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => {
      const c = f(i), o = f(i - 0.7);
      return { time: i * 86400e3, open: o, high: Math.max(o, c) * 1.006, low: Math.min(o, c) * 0.994, close: c, volume: 1000 };
    });
    const down = (i: number) => 100 * Math.pow(0.994, i) * (1 + 0.004 * Math.sin(i / 3));
    const daily = mk(300, down);
    const fourH = mk(300, (i) => down(240 + i / 4));   // same trend at 4H granularity
    expect(notificationBiasAlignment(daily, fourH, true)).toBe('aligned_bearish');
  });

  it('fails safe to neutral on degenerate input', () => {
    expect(notificationBiasAlignment([], [], true)).toBe('neutral');
  });
});
