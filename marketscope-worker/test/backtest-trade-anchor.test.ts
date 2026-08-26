import { describe, it, expect } from 'vitest';
import { oneHIndexAtExact, simulateTrade } from '../scripts/runBacktest';

// The 13th site of the anchor defect, and the only one in TypeScript (plan step 1.5).
//
// `simulateTrade` prices its entry off `fourHAll[i].close` — the price at T+4h — but was handed the
// index of the first 1H bar strictly after `evalTime`, which is T+1h. It therefore scanned three
// hours that had already happened when the entry price came into existence, so a stop could be
// "hit" by a low that occurred before the trade could have been placed.
//
// Not live damage — v14 excludes the `trade*` columns from the feature list — but the same defect
// that inverted the entry-discipline finding in the Python layer, sitting in the export.

const H = 3_600_000;
const bar = (t: number, o: number, h: number, l: number, c: number) =>
  ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });

describe('oneHIndexAtExact', () => {
  const bars = [0, 1, 2, 3, 4, 5].map(k => bar(k * H, 100, 101, 99, 100));

  it('finds the bar opening exactly at the target', () => {
    expect(oneHIndexAtExact(bars, 4 * H)).toBe(4);
    expect(oneHIndexAtExact(bars, 0)).toBe(0);
  });

  it('returns -1 rather than snapping to a neighbour when the hour is missing', () => {
    // Snapping would place the entry at a different time than the price it was priced from —
    // a small, silent version of the very defect this fix is about.
    const gapped = bars.filter(b => b.time !== 4 * H);
    expect(oneHIndexAtExact(gapped, 4 * H)).toBe(-1);
  });

  it('returns -1 past either end', () => {
    expect(oneHIndexAtExact(bars, -H)).toBe(-1);
    expect(oneHIndexAtExact(bars, 99 * H)).toBe(-1);
  });
});

describe('the trade scan starts after the signal bar, not inside it', () => {
  // A tape where the ONLY stop-breaching low sits in the signal bar's own hours (T+1h..T+3h) and
  // everything from T+4h onward drifts up. Under the old anchor this is a STOPPED trade; under the
  // correct one the stop was never reachable.
  const entry = 100, atr = 1;             // stop is 2 ATR away, so ~98
  const preSignal = [1, 2, 3].map(k => bar(k * H, 100, 100.2, 97.0, 100));   // low 97 => breaches
  const postSignal = Array.from({ length: 12 }, (_, k) =>
    bar((4 + k) * H, 100 + k * 0.1, 100.5 + k * 0.1, 99.8 + k * 0.1, 100 + k * 0.1));
  const tape = [bar(0, 100, 100, 100, 100), ...preSignal, ...postSignal];

  it('does not stop out on a low that happened before the entry existed', () => {
    const correct = oneHIndexAtExact(tape, 4 * H);
    expect(correct).toBe(4);
    const r = simulateTrade('aligned_bullish', true, entry, atr, tape, correct);
    expect(r.outcome).not.toBe('STOPPED');
  });

  it('the OLD anchor stops out on exactly that low — the defect, pinned', () => {
    const leaky = 1;                       // the bar at T+1h, which is what the old call produced
    const r = simulateTrade('aligned_bullish', true, entry, atr, tape, leaky);
    expect(r.outcome).toBe('STOPPED');
  });

  it('a neutral bias still simulates nothing', () => {
    const r = simulateTrade('neutral', true, entry, atr, tape, 4);
    expect(r.outcome).toBe('NONE');
  });
});
