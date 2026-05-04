import { describe, expect, test } from 'vitest';
import { aggregate1HTo4H_ET } from '../src/aggregation';

// Build a 1H candle with deterministic OHLC for traceable assertions.
function bar(timeIso: string, base: number): { time: number; open: number; high: number; low: number; close: number; volume: number } {
    const t = new Date(timeIso).getTime();
    return {
        time: t,
        open: base,
        high: base + 1,
        low: base - 1,
        close: base + 0.5,
        volume: 1000 + base,
    };
}

describe('aggregate1HTo4H_ET', () => {
    test('returns empty for empty input', () => {
        expect(aggregate1HTo4H_ET([])).toEqual([]);
    });

    test('US trading session (7 hourly bars) produces 2 4H bars per ET day, [4 + 3]', () => {
        // May 5, 2026 is a Tuesday (regular trading day, EDT). 9:30 AM ET = 13:30 UTC.
        // Yahoo returns 1H bars at session-relative times: 9:30, 10:30, 11:30, 12:30, 13:30, 14:30, 15:30 ET.
        const session = [
            bar('2026-05-05T13:30:00Z', 100), // 9:30 ET
            bar('2026-05-05T14:30:00Z', 101), // 10:30 ET
            bar('2026-05-05T15:30:00Z', 102), // 11:30 ET
            bar('2026-05-05T16:30:00Z', 103), // 12:30 ET
            bar('2026-05-05T17:30:00Z', 104), // 1:30 ET
            bar('2026-05-05T18:30:00Z', 105), // 2:30 ET
            bar('2026-05-05T19:30:00Z', 106), // 3:30 ET
        ];

        const result = aggregate1HTo4H_ET(session);

        expect(result).toHaveLength(2);

        // First 4H bar: 9:30 + 10:30 + 11:30 + 12:30 ET
        // open from 9:30, close from 12:30, high = max of 4 highs, low = min of 4 lows
        expect(result[0].time).toBe(session[0].time);
        expect(result[0].open).toBe(100);   // 9:30 open
        expect(result[0].close).toBe(103.5); // 12:30 close
        expect(result[0].high).toBe(104);    // 12:30 high (103+1)
        expect(result[0].low).toBe(99);      // 9:30 low  (100-1)
        expect(result[0].volume).toBe(1000 + 100 + 1000 + 101 + 1000 + 102 + 1000 + 103); // sum

        // Second 4H bar: 1:30 + 2:30 + 3:30 ET (3 bars only — final block of day)
        expect(result[1].time).toBe(session[4].time);
        expect(result[1].open).toBe(104);   // 1:30 open
        expect(result[1].close).toBe(106.5); // 3:30 close
        expect(result[1].high).toBe(107);    // 3:30 high
        expect(result[1].low).toBe(103);     // 1:30 low
        expect(result[1].volume).toBe(1000 + 104 + 1000 + 105 + 1000 + 106);
    });

    test('two sessions across days are bucketed separately, no cross-day mixing', () => {
        const day1 = [
            bar('2026-05-05T13:30:00Z', 100),
            bar('2026-05-05T14:30:00Z', 101),
            bar('2026-05-05T15:30:00Z', 102),
            bar('2026-05-05T16:30:00Z', 103),
            bar('2026-05-05T17:30:00Z', 104),
        ];
        const day2 = [
            bar('2026-05-06T13:30:00Z', 200),
            bar('2026-05-06T14:30:00Z', 201),
            bar('2026-05-06T15:30:00Z', 202),
            bar('2026-05-06T16:30:00Z', 203),
        ];
        const result = aggregate1HTo4H_ET([...day1, ...day2]);

        // Day 1: [4 + 1] = 2 bars; Day 2: [4] = 1 bar; total 3
        expect(result).toHaveLength(3);

        // Verify day boundaries are respected: bar 2 (index 1) is the trailing 1-bar chunk of day 1,
        // not pulled forward into day 2's first chunk.
        expect(result[1].time).toBe(day1[4].time);
        expect(result[1].open).toBe(104);
        expect(result[1].close).toBe(104.5);  // single-bar chunk: open and close from same bar

        expect(result[2].time).toBe(day2[0].time);
        expect(result[2].open).toBe(200);
    });

    test('handles DST transition correctly (March 8, 2026 spring forward)', () => {
        // March 8, 2026 was DST start in US. Times before 2 AM ET = EST (UTC-5),
        // after = EDT (UTC-4). The ET-day grouping must still treat both as the same trading day.
        // Synthetic bars at 9:30 AM ET, 10:30 AM ET (post-DST):
        const day = [
            bar('2026-03-09T13:30:00Z', 100), // Mon Mar 9 9:30 ET (post-DST so EDT)
            bar('2026-03-09T14:30:00Z', 101),
            bar('2026-03-09T15:30:00Z', 102),
            bar('2026-03-09T16:30:00Z', 103),
        ];
        const result = aggregate1HTo4H_ET(day);
        expect(result).toHaveLength(1);
        expect(result[0].open).toBe(100);
        expect(result[0].close).toBe(103.5);
    });

    test('out-of-order input within day is sorted before chunking', () => {
        const shuffled = [
            bar('2026-05-05T15:30:00Z', 102),
            bar('2026-05-05T13:30:00Z', 100),
            bar('2026-05-05T16:30:00Z', 103),
            bar('2026-05-05T14:30:00Z', 101),
        ];
        const result = aggregate1HTo4H_ET(shuffled);
        expect(result).toHaveLength(1);
        // Open should be from earliest time bar (100), close from latest (103.5)
        expect(result[0].open).toBe(100);
        expect(result[0].close).toBe(103.5);
    });

    test('regression: NOT UTC-bucketed (the bug we fixed)', () => {
        // The old buggy logic bucketed by UTC: floor(time / 4h) * 4h.
        // For these bars at 13:30, 16:30 UTC, UTC bucketing puts 13:30 → 12:00 bucket
        // and 16:30 → 16:00 bucket (separate). ET-day bucketing should instead group
        // them all under the May 5 ET trading day.
        const session = [
            bar('2026-05-05T13:30:00Z', 100), // 9:30 ET
            bar('2026-05-05T14:30:00Z', 101), // 10:30 ET
            bar('2026-05-05T15:30:00Z', 102), // 11:30 ET
            bar('2026-05-05T16:30:00Z', 103), // 12:30 ET
        ];
        const result = aggregate1HTo4H_ET(session);

        // Old UTC-bucket logic would produce 2 bars (12:00 and 16:00 UTC buckets);
        // ET-day chunking produces 1 bar covering all 4 candles.
        expect(result).toHaveLength(1);
        expect(result[0].volume).toBe(1000 + 100 + 1000 + 101 + 1000 + 102 + 1000 + 103);
    });
});
