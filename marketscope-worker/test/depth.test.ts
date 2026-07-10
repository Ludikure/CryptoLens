// Order-book depth snapshot summarizer (src/index.ts summarizeDepth) — the pure half of the
// depth_snapshots collector. Sums USD-notional resting liquidity within ±0.5/1/2% of mid and
// records each side's actual span so truncated books stay self-describing.
import { describe, it, expect } from 'vitest';
import { summarizeDepth } from '../src/index';

const lvl = (p: number, q: number): [string, string] => [String(p), String(q)];

describe('summarizeDepth', () => {
  it('sums bands correctly around mid (mid=100)', () => {
    // bestBid 99.9, bestAsk 100.1 → mid 100. Bands: ±0.5% = [99.5,100.5], ±1% = [99,101], ±2% = [98,102].
    const bids = [lvl(99.9, 1), lvl(99.6, 2), lvl(99.2, 3), lvl(98.5, 4), lvl(97.0, 99)];
    const asks = [lvl(100.1, 1), lvl(100.4, 2), lvl(100.9, 3), lvl(101.5, 4), lvl(103.0, 99)];
    const d = summarizeDepth(bids, asks)!;
    expect(d.mid).toBeCloseTo(100, 6);
    expect(d.bestBid).toBeCloseTo(99.9, 6);
    expect(d.bestAsk).toBeCloseTo(100.1, 6);
    // bid05: 99.9×1 + 99.6×2 = 299.1; bid1: + 99.2×3 = 596.7; bid2: + 98.5×4 = 990.7 (97.0 excluded, >2%)
    expect(d.bid05).toBeCloseTo(299.1, 3);
    expect(d.bid1).toBeCloseTo(596.7, 3);
    expect(d.bid2).toBeCloseTo(990.7, 3);
    // ask05: 100.1 + 100.4×2 = 300.9; ask1: + 100.9×3 = 603.6; ask2: + 101.5×4 = 1009.6
    expect(d.ask05).toBeCloseTo(300.9, 3);
    expect(d.ask1).toBeCloseTo(603.6, 3);
    expect(d.ask2).toBeCloseTo(1009.6, 3);
    // spans reach the last counted level (98.5 → 1.5% below; 101.5 → 1.5% above)
    expect(d.bidSpanPct).toBeCloseTo(1.5, 5);
    expect(d.askSpanPct).toBeCloseTo(1.5, 5);
  });

  it('a thin book that never reaches ±2% reports its true (shorter) span', () => {
    // All levels within ±0.3% — the ±1%/±2% sums equal the ±0.5% sum, span says why.
    const d = summarizeDepth([lvl(99.9, 1), lvl(99.8, 1)], [lvl(100.1, 1), lvl(100.2, 1)])!;
    expect(d.bid2).toBeCloseTo(d.bid05, 6);
    expect(d.bidSpanPct).toBeLessThan(0.5);
    expect(d.askSpanPct).toBeLessThan(0.5);
  });

  it('rejects empty/crossed/junk books', () => {
    expect(summarizeDepth([], [lvl(100, 1)])).toBeNull();
    expect(summarizeDepth([lvl(100, 1)], [])).toBeNull();
    expect(summarizeDepth([lvl(101, 1)], [lvl(100, 1)])).toBeNull();   // crossed
    expect(summarizeDepth([lvl(0, 1)], [lvl(100, 1)])).toBeNull();
  });
});
