// The conviction ladder must be MONOTONE (2026-08-26).
//
// `highBlocks` cap conviction at MODERATE; `moderateBlocks` cap it at LOW — their own labels say so
// (`earnings_in_5d_cap_MODERATE` vs `earnings_in_1d_cap_LOW`). The old expression was
//
//     autoFlat.length ? 'FLAT' : highBlocks.length === 0 ? 'HIGH' : moderateBlocks.length === 0 ? 'MODERATE' : 'LOW'
//
// which tests `highBlocks` FIRST, so any moderateBlock was ignored whenever no highBlock fired.
// Found by the behavioural helper on its first run: a stock one day from earnings reported
// `max_allowed: HIGH` alongside its own `earnings_in_1d_cap_LOW`. The model is told "You may NOT
// output a tier above max_allowed", so the operative half was the wrong one — and the earnings 0-2d
// gate is the one condition in this system validated on its own stated mechanism (7.08x baseline
// gap rate, 8/8 periods).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { envelopeFor, BIAS, MIN_STOCK_INFO } from './helpers/envelope';

const NOW_MS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'btc-rally-2026-08.json'), 'utf-8'))
  .fourH.slice(-1)[0].time + 14400e3;

describe('max_allowed is monotone with the block lists', () => {
  it('a moderateBlock caps at LOW even when no highBlock fires', () => {
    // One day from earnings, everything else clean. Previously reported HIGH.
    const e = envelopeFor({
      ml: 0.80, symbol: 'AAPL', ...BIAS.alignedBullish,
      stockInfo: { ...MIN_STOCK_INFO, earningsDate: NOW_MS + 86_400_000 },
    });
    expect(e.moderateBlocks).toContain('earnings_in_1d_cap_LOW');
    expect(e.highBlocks).toEqual([]);
    expect(e.maxAllowed).toBe('LOW');
  });

  it('holds for the crypto SHORT continuation cap too', () => {
    const e = envelopeFor({ ml: 0.80, ...BIAS.alignedBearish });
    expect(e.moderateBlocks.some(r => r.startsWith('continuation_'))).toBe(true);
    expect(e.maxAllowed).toBe('LOW');
  });

  it('holds for the LONG_CONFIRMATION PARTIAL cap', () => {
    const e = envelopeFor({
      ml: 0.80, symbol: 'AAPL', ...BIAS.alignedBullish,
      stockInfo: { ...MIN_STOCK_INFO, relativeStrength1d: -3 },
    });
    expect(e.moderateBlocks).toContain('treatment_long_confirm_PARTIAL_cap_LOW');
    expect(e.maxAllowed).toBe('LOW');
  });

  it('a highBlock alone still caps at MODERATE, not LOW', () => {
    const e = envelopeFor({ ml: 0.62, ...BIAS.alignedBullish });
    expect(e.highBlocks.some(r => r.startsWith('ML_WIN_'))).toBe(true);
    expect(e.moderateBlocks).toEqual([]);
    expect(e.maxAllowed).toBe('MODERATE');
  });

  it('a clean envelope still reaches HIGH', () => {
    const e = envelopeFor({ ml: 0.80, ...BIAS.alignedBullish });
    expect(e.autoFlat).toEqual([]);
    expect(e.highBlocks).toEqual([]);
    expect(e.moderateBlocks).toEqual([]);
    expect(e.maxAllowed).toBe('HIGH');
  });

  it('autoFlat outranks everything', () => {
    const e = envelopeFor({ ml: 0.20, ...BIAS.mixed });
    expect(e.autoFlat.length).toBeGreaterThan(0);
    expect(e.maxAllowed).toBe('FLAT');
  });

  it('the invariant itself, stated as a property over every state exercised here', () => {
    const states = [
      { ml: 0.80, ...BIAS.alignedBullish },
      { ml: 0.62, ...BIAS.alignedBullish },
      { ml: 0.80, ...BIAS.alignedBearish },
      { ml: 0.55, ...BIAS.higherTfOnly },
      { ml: 0.20, ...BIAS.mixed },
      { ml: 0.80, symbol: 'AAPL', ...BIAS.alignedBullish },
      { ml: 0.55, symbol: 'AAPL', ...BIAS.alignedBearish },
    ];
    for (const s of states) {
      const e = envelopeFor(s as never);
      const expected = e.autoFlat.length ? 'FLAT'
        : e.moderateBlocks.length ? 'LOW'
        : e.highBlocks.length ? 'MODERATE' : 'HIGH';
      expect(`${JSON.stringify(s)} -> ${e.maxAllowed}`).toBe(`${JSON.stringify(s)} -> ${expected}`);
    }
  });
});
