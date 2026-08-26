import { describe, it, expect } from 'vitest';
import { resolveBarContext, sliceSectorETF, type GlobalContext } from '../scripts/context';

// Plan step 4.1. `context.ts` sliced every DAILY cross-asset series at the 4H bar's OPEN. A daily
// candle is stamped at its open, so at an intraday bar the CURRENT day's candle was included — and
// its OHLC spans the whole day, including hours AFTER the bar. SPY's close for a day is not knowable
// at 10am on that day.
//
// Unlike the `trade*` columns, these features SHIP: relStrengthVsSpy, relStrengthVsSector,
// iwmSpyRatio, beta, vixLevelCode, vixTermStructure, dxyMomentum and dxyAboveEma20 are all in the
// live `ml-model-stock.json` feature list.

const DAY = 86_400_000;
const d = (t: number, close: number) => ({ time: t, open: close, high: close, low: close, close, volume: 1 });

/** Three daily bars: day 0, day 1, day 2. */
const daily = [d(0, 100), d(DAY, 110), d(2 * DAY, 120)];

const ctx = (over: Partial<GlobalContext> = {}): GlobalContext => ({
  fearGreed: [], ethBtcFourH: [],
  vixDaily: daily, vix3mDaily: daily, dxyDaily: daily, dxyEma20List: [99, 109, 119],
  spyDaily: daily, iwmDaily: daily,
  sectorETFDaily: new Map([['XLK', daily]]),
  darkPool: null,
  ...over,
} as unknown as GlobalContext);

describe('cross-asset slices exclude the in-progress day', () => {
  // An intraday bar on day 2: 12 hours into a day that has not closed.
  const intraday = 2 * DAY + 12 * 3_600_000;

  it('SPY stops at the last CLOSED day, not the running one', () => {
    const c = resolveBarContext(ctx(), intraday);
    expect(c.spyCandlesSlice.map(x => x.close)).toEqual([100, 110]);
    expect(c.spyCandlesSlice.at(-1)!.close).not.toBe(120);   // day 2 is still running
  });

  it('IWM and DXY get the same guard', () => {
    const c = resolveBarContext(ctx(), intraday);
    expect(c.iwmCandlesSlice.map(x => x.close)).toEqual([100, 110]);
    expect(c.dxyCandlesSlice.map(x => x.close)).toEqual([100, 110]);
  });

  it('VIX and VIX3M read the last closed close', () => {
    const c = resolveBarContext(ctx(), intraday);
    expect(c.macro.vix).toBe(110);
    expect(c.vix3mPrice).toBe(110);
  });

  it('the sector ETF slice is guarded too — it is sliced by the caller, not here', () => {
    const c = resolveBarContext(ctx(), intraday);
    expect(sliceSectorETF(c, 'AAPL', intraday).map(x => x.close)).toEqual([100, 110]);
  });

  it('matches what live does: a day becomes visible once it has fully closed', () => {
    // `dropInProgress` keeps a daily candle once `open + 24h <= now`. At exactly midnight of day 2,
    // day 1 has closed and day 2 has not.
    const atMidnight = resolveBarContext(ctx(), 2 * DAY);
    expect(atMidnight.spyCandlesSlice.map(x => x.close)).toEqual([100, 110]);
    // One day later, day 2 is available.
    const nextDay = resolveBarContext(ctx(), 3 * DAY);
    expect(nextDay.spyCandlesSlice.map(x => x.close)).toEqual([100, 110, 120]);
  });

  it('the OLD behaviour is what a same-day slice would give — the defect, stated', () => {
    // Without the guard, an intraday bar on day 2 saw day 2's close of 120: a price that had not
    // happened yet. This asserts the counterfactual so the fix cannot be silently reverted.
    const withGuard = resolveBarContext(ctx(), intraday).spyCandlesSlice.length;
    const withoutGuard = daily.filter(x => x.time <= intraday).length;
    expect(withoutGuard).toBe(3);
    expect(withGuard).toBe(2);
  });
});
