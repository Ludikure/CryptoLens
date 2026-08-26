import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CSV_HEADER } from '../scripts/csv';

// Plan step 4.4. The forward columns are counted in BARS, and a stock "4H" bar is ET-session
// aggregated, so `fwdReturn24H` measures a one-day return on crypto and a FIVE-day return on stocks
// under one name and one column index.
//
// Measured on the box archive, span from bar i to bar i+6:
//     BTCUSDT  median  24h   AAPL / MSFT / JPM / XOM / SPY  median 120h (p10 72h, p90 144h)
//
// Not converted — that would change every stock label and force a retrain. `fwdSpanHours` records
// the units instead, so they are a fact rather than an inference from a column name.

describe('the forward window records its own span', () => {
  it('fwdSpanHours is in the header, appended at the end', () => {
    expect(CSV_HEADER.split(',')).toContain('fwdSpanHours');
    expect(CSV_HEADER.split(',').at(-1)).toBe('fwdSpanHours');
  });

  it('the append-at-end convention holds — earlier columns keep their indexes', () => {
    // Python consumers read these CSVs BY COLUMN INDEX, so an insertion anywhere but the end would
    // silently corrupt training labels rather than fail.
    const cols = CSV_HEADER.split(',');
    expect(cols[0]).toBe('symbol');
    expect(cols[1]).toBe('timestamp');
    expect(cols[2]).toBe('price');
    expect(cols.indexOf('fwdReturn24H')).toBeLessThan(cols.indexOf('barCloseTimestampMs'));
  });

  it('the units are documented where the window is computed, with the measured numbers', () => {
    // "gap risk" as a bare phrase invites a reader to assume; "median 120h" does not. Same reasoning
    // as putting the measured earnings gap rates into the prompt rather than the word "risk".
    const src = readFileSync(join(__dirname, '..', 'scripts', 'runBacktest.ts'), 'utf-8');
    expect(src).toMatch(/median 120h/);
    expect(src).toMatch(/BTCUSDT\s+median\s+24h/);
    expect(src).toMatch(/FIVE-day return on stocks/);
  });
});
