import { describe, it, expect } from 'vitest';
import { computeOpportunities, type AssetInput } from '../src/trading/service';
import { excursionModelInfo, headIsShippable } from '../src/trading/excursion';
import { crashWarning } from '../src/trading/crash';
import { DEFAULT_STRUCTURE } from '../src/trading/generator';
import type { PortfolioState } from '../src/trading/sizing';

const t = Date.parse('2026-08-24T12:00:00Z');
const closes = (n: number, start = 100, drift = 0.0004, amp = 0.006) =>
  Array.from({ length: n }, (_, i) => start * (1 + drift * i + amp * Math.sin(i / 5)));

const feats = (o: Record<string, number> = {}): Record<string, number> => {
  const base: Record<string, number> = {};
  for (const k of ['dRsi', 'dAdx', 'dMacdHist', 'hRsi', 'hAdx', 'eRsi', 'atrPercent',
    'atrPercentile', 'vix', 'dxy', 'fearGreedIndex', 'ethBtcRatio', 'dayOfWeek', 'regimeCode',
    'tfAlignment', 'momentumAlignment', 'structureAlignment', 'fundingRateRaw', 'oiChangePct',
    'takerRatioRaw', 'longPctRaw', 'dBBPercentB', 'hBBPercentB', 'dVolumeRatio', 'hVolumeRatio']) {
    base[k] = 1;
  }
  return { ...base, ...o };
};

const asset = (o: Partial<AssetInput> = {}): AssetInput => ({
  asset: 'SOLUSDT', closes1h: closes(800), price: 100, atr: 4, mlWin: 0.55,
  crashProbability: 0.1, liquidityUsd24h: 50_000_000, isCrypto: true, dataTimestamp: t,
  features: feats({ vix: 13, fearGreedIndex: 82, atrPercent: 1.1, dRsi: 68, ethBtcRatio: 0.062 }),
  ...o,
});
const portfolio = (): PortfolioState => ({ equity: 25000, openNotionalByAsset: {}, correlations: {} });

// THE GAUGE MUST HAVE A READING ON A QUIET DAY.
//
// `crashWarning` fires on the MARGIN over the 41% base rate, deliberately, so on an ordinary day
// `crashWarnings` is empty. A screen driven only by warnings therefore renders nothing most days,
// which is indistinguishable from a broken feed — the exact ambiguity that cost six weeks of
// liquidation capture (2026-08-22f). The readings are the fix: "44%, and a normal day is 41%".
describe('crashReadings', () => {
  it('carries a reading for a quiet asset that produces no warning', () => {
    const quiet = 0.42;                       // one point over the base rate — nothing to say
    expect(crashWarning(quiet)).toBeNull();

    const r = computeOpportunities([asset({ crashProbability: quiet })], portfolio(), t);
    expect(r.crashWarnings).toHaveLength(0);
    expect(r.crashReadings).toEqual([{ asset: 'SOLUSDT', probability: quiet }]);
  });

  it('covers every scored asset, warning or not, and stays aligned with the warnings', () => {
    const r = computeOpportunities([
      asset({ asset: 'SOLUSDT', crashProbability: 0.62 }),   // HIGH
      asset({ asset: 'XRPUSDT', crashProbability: 0.50 }),   // ELEVATED
      asset({ asset: 'BTCUSDT', crashProbability: 0.42 }),   // silent
    ], portfolio(), t);

    expect(r.crashReadings.map(x => x.asset)).toEqual(['SOLUSDT', 'XRPUSDT', 'BTCUSDT']);
    // Every warning has a reading behind it; not every reading warns.
    for (const w of r.crashWarnings) {
      expect(r.crashReadings.find(x => x.asset === w.asset)?.probability).toBe(w.probability);
    }
    expect(r.crashWarnings.length).toBeLessThan(r.crashReadings.length);
  });

  it('omits an asset with no crash input rather than reporting a zero', () => {
    // A missing reading and a 0% reading say opposite things. Never substitute one for the other.
    const r = computeOpportunities(
      [asset({ crashProbability: null, features: undefined })], portfolio(), t);
    expect(r.crashReadings).toHaveLength(0);
  });
});

// THE NUMBER THAT EXPLAINS WHY A LONG CARRIES NO RANKING.
//
// The screen states "the 7.6% base rate every long shares". That figure must come from the model
// artifact, not a literal in a Swift file, or it silently goes stale on the next retrain.
describe('excursionModelInfo().baseWinRate', () => {
  it('serves the measured hit rate at the primary target for both sides', () => {
    const info = excursionModelInfo() as unknown as
      { primaryR: number; baseWinRate: { long: number | null; short: number | null } };
    // Guards the `String(primaryR)` lookup: a fractional primaryR would miss every baseCurve key
    // and hand the UI a null it would have to invent a number for.
    expect(typeof info.baseWinRate.long).toBe('number');
    expect(typeof info.baseWinRate.short).toBe('number');
    expect(info.baseWinRate.long!).toBeGreaterThan(0);
    expect(info.baseWinRate.long!).toBeLessThan(0.2);
    expect(info.baseWinRate.long!).toBeCloseTo(0.0762, 3);
  });

  it('is the rate the LONG side actually falls back to, because that head is refused', () => {
    expect(headIsShippable('LONG')).toBe(false);
    expect(headIsShippable('SHORT')).toBe(true);
  });
});

// THE FEE IS A USER PARAMETER, AND IT DECIDES THE SIGN OF ROUGHLY HALF THESE ROWS.
//
// `netExpectedValueR` subtracts `roundTripPercent / stopDistancePercent`, so at a 2% stop a 0.171%
// round trip costs 0.086R against a gross edge around 0.15R. Serving someone else's fee schedule is
// therefore not a rounding error — it flips rows across the display floor in both directions.
describe('fee sensitivity', () => {
  const gross = (fee: number) => {
    const r = computeOpportunities([asset()], portfolio(), t,
      { ...DEFAULT_STRUCTURE, roundTripPercent: fee });
    return r.allocation.accepted[0]?.candidate.payoff.expectedValueR;
  };

  it('a higher fee strictly lowers expected value, and by the amount the formula says', () => {
    const zero = gross(0), shipped = gross(0.171);
    expect(zero).toBeDefined();
    expect(shipped!).toBeLessThan(zero!);
    // stop is 1 ATR on a price of 100 with atr 4 => 4% stop distance => 0.171/4 = 0.042750R
    expect(zero! - shipped!).toBeCloseTo(0.171 / 4, 6);
  });

  it('a fee large enough removes the row entirely rather than showing a negative edge', () => {
    // `buildSide` rejects non-positive EV outright, which is the behaviour that makes an empty book
    // an honest answer rather than a failure.
    expect(gross(2)).toBeUndefined();
  });
});
