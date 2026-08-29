import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeAllFeatures, type Candle } from '../src/scoring-full';

// Plan step 4.3 — a train/serve skew on the model's most-used temporal input.
//
// `computeAllFeatures`'s `evalTimeMs` defaults to `Date.now()`, and the live cron was not passing it.
// TRAINING passes the 4H bar's OPEN (`runBacktest.ts:487`). The cron runs every minute against the
// last CLOSED bar, so `Date.now()` sits in [T+4h, T+8h) — the model was trained on one timestamp and
// served another, four to eight hours later.
//
// Measured over 9,673 real 4H bar opens (2022-2026), by cron lag:
//
//     lag    dayOfWeek   hourBucket   isWeekend
//      4h      16.68%       55.96%       4.78%
//      8h      33.35%       99.96%       9.55%
//
// `dayOfWeek` is crypto's TOP permutation feature (+0.048) and `news_catalyst_test` measured BTC
// goodR swinging 34pp across days of the week, so this is skew on the temporal input the model leans
// on hardest.

const bars = (n: number, base: number, startMs: number, stepMs: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: startMs + i * stepMs,
    open: base + Math.sin(i / 7) * 2, high: base + 3 + Math.sin(i / 7) * 2,
    low: base - 3 + Math.sin(i / 7) * 2, close: base + Math.sin(i / 5) * 2, volume: 1000 + i,
  }));

const H = 3_600_000;
/** Friday 2026-01-02 22:00 ET = Saturday 03:00 UTC. +8h crosses into the ET weekend. */
const FRI_LATE_ET = Date.UTC(2026, 0, 3, 3, 0, 0);

function temporal(evalTimeMs: number) {
  const f = computeAllFeatures(
    bars(300, 100, evalTimeMs - 300 * 24 * H, 24 * H),
    bars(300, 100, evalTimeMs - 300 * 4 * H, 4 * H),
    bars(300, 100, evalTimeMs - 300 * H, H),
    true,
    { fundingSignal: 0, oiSignal: 0, takerSignal: 0, crowdingSignal: 0, derivativesCombined: 0 },
    { vix: 18, dxyAboveEma20: 1 },
    undefined, undefined, [], undefined, [], [], [], 0, 'BTCUSDT',
    evalTimeMs,
  );
  return { dayOfWeek: f.dayOfWeek, hourBucket: f.hourBucket, isWeekend: f.isWeekend };
}

describe('temporal features follow evalTimeMs, not the wall clock', () => {
  it('a 4-8h shift moves hourBucket', () => {
    // ET 22:00 is bucket 3; ET 06:00 the next morning is bucket 0.
    expect(temporal(FRI_LATE_ET).hourBucket).not.toBe(temporal(FRI_LATE_ET + 8 * H).hourBucket);
  });

  it('a 4-8h shift moves dayOfWeek and isWeekend across an ET midnight', () => {
    const train = temporal(FRI_LATE_ET);
    const served = temporal(FRI_LATE_ET + 8 * H);
    expect(train.dayOfWeek).toBe(5);          // Friday
    expect(train.isWeekend).toBe(0);
    expect(served.dayOfWeek).toBe(6);         // Saturday
    expect(served.isWeekend).toBe(1);
  });

  it('the same evalTimeMs always gives the same answer — no wall-clock dependence', () => {
    expect(temporal(FRI_LATE_ET)).toEqual(temporal(FRI_LATE_ET));
  });
});

describe('every live call site passes evalTimeMs', () => {
  // A source property, and legitimately so: the defect was an OMITTED optional argument, which no
  // behavioural test of the cron can reach without running the cron. The default is `Date.now()`,
  // so forgetting the argument is silent — exactly the shape that let this sit unnoticed.
  it('src/index.ts does not rely on the Date.now() default', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8');
    const calls = src.match(/computeAllFeatures\([^;]*?\);/gs) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `a computeAllFeatures call omits evalTimeMs:\n${call.slice(0, 200)}`)
        .toMatch(/evalTimeMs\s*\)/);
    }
  });
});
