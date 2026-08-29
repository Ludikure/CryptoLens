// Paper trader core: the book walk, the contract resolution, and every fill rule in the sim.
import { describe, it, expect } from 'vitest';
import { OrderBook } from '../src/paper/book';
import { resolveContracts } from '../src/paper/contracts';
import { PaperSim, paperStats, type Intent } from '../src/paper/sim';
import { intentsFromBook } from '../src/paper/intents';

const T0 = 1_787_960_000_000;
const H = 3600_000;

function book(bids: Array<[number, number]>, asks: Array<[number, number]>): OrderBook {
  const b = new OrderBook();
  b.applySnapshot([
    ...bids.map(([p, q]) => ({ side: 'bid', price_level: String(p), new_quantity: String(q) })),
    ...asks.map(([p, q]) => ({ side: 'offer', price_level: String(p), new_quantity: String(q) })),
  ], T0);
  return b;
}

describe('OrderBook', () => {
  it('walks the bids best-first for a sell and reports the VWAP, levels and shortfall', () => {
    const b = book([[100, 2], [99, 3], [98, 10]], [[101, 5]]);
    const w = b.walk('sell', 4);
    expect(w.filled).toBe(4);
    expect(w.avgPrice).toBeCloseTo((2 * 100 + 2 * 99) / 4, 9);
    expect(w.levels).toBe(2);
    expect(w.shortfall).toBe(0);
    const thin = b.walk('sell', 100);
    expect(thin.filled).toBe(15); expect(thin.shortfall).toBe(85);
  });
  it('a zero-quantity update removes the level; snapshot replaces everything', () => {
    const b = book([[100, 2]], [[101, 5]]);
    b.applyUpdate([{ side: 'bid', price_level: '100', new_quantity: '0' }], T0 + 1);
    expect(b.bestBid()).toBeNull();
    b.applySnapshot([{ side: 'bid', price_level: '90', new_quantity: '1' }], T0 + 2);
    expect(b.bestBid()).toBe(90); expect(b.bestAsk()).toBeNull();
  });
  it('spread in bps and USD depth within a band', () => {
    const b = book([[99.5, 10]], [[100.5, 10]]);
    expect(b.spreadBps()).toBeCloseTo(100, 6);
    expect(b.depthUsd('bid', 0.01, 5)).toBeCloseTo(99.5 * 10 * 5, 6);
    expect(b.depthUsd('bid', 0.001, 5)).toBe(0);
  });
});

describe('resolveContracts — the US venue as it actually is', () => {
  const now = Date.parse('2026-08-29T00:00:00Z');
  const prod = (id: string, size: number, expiry?: string) => ({
    product_id: id, quote_increment: '0.01',
    future_product_details: { contract_size: String(size), contract_expiry: expiry },
  });
  const products = [
    prod('BIP-20DEC30-CDE', 0.01, '2030-12-20T16:00:00Z'), prod('BIT-25SEP26-CDE', 0.01, '2026-09-25T15:00:00Z'),
    prod('ETP-20DEC30-CDE', 0.1, '2030-12-20T16:00:00Z'),
    prod('SOL-25SEP26-CDE', 5, '2026-09-25T15:00:00Z'), prod('SOL-30OCT26-CDE', 5, '2026-10-30T15:00:00Z'),
    prod('XRP-25SEP26-CDE', 500, '2026-09-25T15:00:00Z'),
    prod('ADA-25SEP26-CDE', 1000, '2026-09-25T15:00:00Z'), prod('ADA-30OCT26-CDE', 1000, '2026-10-30T15:00:00Z'),
    prod('SOL-PERP-INTX', 1),   // not a US product: must never be picked
  ];
  it('BTC/ETH take the perp-style nanos; alts take the FRONT month; DOGE is null', () => {
    const r = resolveContracts(products, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT'], now, 72 * H);
    expect(r.BTCUSDT?.productId).toBe('BIP-20DEC30-CDE'); expect(r.BTCUSDT?.perpStyle).toBe(true);
    expect(r.ETHUSDT?.contractSize).toBe(0.1);
    expect(r.SOLUSDT?.productId).toBe('SOL-25SEP26-CDE');
    expect(r.XRPUSDT?.contractSize).toBe(500);
    expect(r.DOGEUSDT).toBeNull();
  });
  it('a dated contract expiring inside the hold (+buffer) is skipped for the next month', () => {
    const late = Date.parse('2026-09-23T00:00:00Z');   // Sep contract expires in 2.6 days
    const r = resolveContracts(products, ['SOLUSDT', 'XRPUSDT'], late, 72 * H);
    expect(r.SOLUSDT?.productId).toBe('SOL-30OCT26-CDE');
    expect(r.XRPUSDT).toBeNull();                       // no October XRP in this fixture
  });
});

describe('PaperSim — every fill rule', () => {
  const intent: Intent = { symbol: 'SOLUSDT', direction: 'SHORT', stopDistance: 2, targetDistance: 10,
                           riskUsd: 500, holdMs: 72 * H, expectedValueR: 0.07, source: 'scanner' };
  const SIZE = 5;   // SOL contract

  it('a short sells into the bids, sizes whole contracts off the FILLED price, arms stop and target', () => {
    const sim = new PaperSim();
    const b = book([[100, 30], [99.9, 30], [99.8, 100]], [[100.1, 50]]);
    const ev = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    expect(ev.kind).toBe('opened');
    if (ev.kind !== 'opened') return;
    const p = ev.position;
    // risk 500 / (5 * 2) = 50 contracts: 30 @100 + 20 @99.9
    expect(p.contracts).toBe(50);
    expect(p.entryPrice).toBeCloseTo((30 * 100 + 20 * 99.9) / 50, 9);
    expect(p.entryLevels).toBe(2);
    expect(p.entrySlippageBps).toBeGreaterThan(0);
    expect(p.stopPrice).toBeCloseTo(p.entryPrice + 2, 9);
    expect(p.targetPrice).toBeCloseTo(p.entryPrice - 10, 9);
    expect(p.riskUsd).toBeCloseTo(50 * 5 * 2, 9);
    // entry fee: 0.07% of notional + $0.12/contract
    expect(p.feesUsd).toBeCloseTo(50 * 5 * p.entryPrice * 0.0007 + 50 * 0.12, 6);
  });

  it('a thin book fills fewer contracts and the risk shrinks with it — never the stop', () => {
    const sim = new PaperSim();
    const b = book([[100, 7]], [[100.1, 50]]);
    const ev = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    expect(ev.kind).toBe('opened');
    if (ev.kind === 'opened') { expect(ev.position.contracts).toBe(7); expect(ev.position.riskUsd).toBe(7 * 5 * 2); }
  });

  it('caps: max open and one per symbol are enforced, with plain reasons', () => {
    const sim = new PaperSim(undefined, { maxOpen: 1, onePerSymbol: true });
    const b = book([[100, 1000]], [[100.1, 1000]]);
    expect(sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0).kind).toBe('opened');
    const again = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0 + 1);
    expect(again.kind).toBe('rejected');
    if (again.kind === 'rejected') expect(again.reason).toMatch(/max 1 open/);
  });

  it('STOP triggers on a print at/above the stop and fills by walking the asks — slippage is real', () => {
    const sim = new PaperSim();
    const b = book([[100, 1000]], [[100.1, 1000]]);
    const ev = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    if (ev.kind !== 'opened') throw new Error();
    const p = ev.position;
    // a print just under the stop does nothing
    expect(sim.onTrade('SOL-25SEP26-CDE', p.stopPrice - 0.01, 1, T0 + H, b)).toEqual([]);
    // the book has moved: asks now thin and above the stop
    const runBook = book([[101.9, 10]], [[102.5, 20], [103, 100]]);
    const evs = sim.onTrade('SOL-25SEP26-CDE', p.stopPrice, 1, T0 + 2 * H, runBook);
    expect(evs.length).toBe(1);
    const c = evs[0]; if (c.kind !== 'closed') throw new Error();
    expect(c.position.exitReason).toBe('stop');
    expect(c.position.exitPrice).toBeCloseTo((20 * 102.5 + 30 * 103) / 50, 9);   // worse than the stop level
    expect(c.position.realizedR).toBeLessThan(-1);                                 // slippage + fees past −1R
  });

  it('TARGET needs prints AT/UNDER the target to accumulate OUR size — a touch is not a fill', () => {
    const sim = new PaperSim();
    const b = book([[100, 1000]], [[100.1, 1000]]);
    const ev = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    if (ev.kind !== 'opened') throw new Error();
    const p = ev.position;
    expect(sim.onTrade('SOL-25SEP26-CDE', p.targetPrice, 10, T0 + H, b)).toEqual([]);        // 10 of 50
    expect(sim.onTrade('SOL-25SEP26-CDE', p.targetPrice + 0.5, 100, T0 + H, b)).toEqual([]);  // above target: no
    expect(sim.onTrade('SOL-25SEP26-CDE', p.targetPrice - 0.2, 39, T0 + H, b)).toEqual([]);   // 49 of 50
    const evs = sim.onTrade('SOL-25SEP26-CDE', p.targetPrice - 0.1, 1, T0 + H, b);
    expect(evs.length).toBe(1);
    const c = evs[0]; if (c.kind !== 'closed') throw new Error();
    expect(c.position.exitReason).toBe('target');
    expect(c.position.exitPrice).toBeCloseTo(p.targetPrice, 9);
    // 5R gross minus two sides of fees
    expect(c.position.realizedR).toBeGreaterThan(4.8); expect(c.position.realizedR).toBeLessThan(5);
  });

  it('TIME exit at the horizon walks the asks; before the horizon nothing happens', () => {
    const sim = new PaperSim();
    const b = book([[100, 1000]], [[100.1, 1000]]);
    const ev = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    if (ev.kind !== 'opened') throw new Error();
    expect(sim.onClock(T0 + 71 * H, () => b)).toEqual([]);
    const later = book([[99, 1000]], [[99.2, 1000]]);
    const evs = sim.onClock(T0 + 72 * H, () => later);
    expect(evs.length).toBe(1);
    const c = evs[0]; if (c.kind !== 'closed') throw new Error();
    expect(c.position.exitReason).toBe('time');
    expect(c.position.exitPrice).toBeCloseTo(99.2, 9);
    expect(c.position.pnlUsd).toBeGreaterThan(0);
  });

  it('a stop on another product does not touch this position', () => {
    const sim = new PaperSim();
    const b = book([[100, 1000]], [[100.1, 1000]]);
    sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    expect(sim.onTrade('XRP-25SEP26-CDE', 1e9, 1, T0 + H, b)).toEqual([]);
    expect(sim.open.length).toBe(1);
  });

  it('paperStats: drawdown on the equity path, PF, fees, exit reasons', () => {
    const sim = new PaperSim();
    const b = book([[100, 1000]], [[100.1, 1000]]);
    const e1 = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0);
    if (e1.kind !== 'opened') throw new Error();
    sim.onTrade('SOL-25SEP26-CDE', e1.position.stopPrice, 1, T0 + H, b);           // loss
    const e2 = sim.openShort(intent, 'SOL-25SEP26-CDE', SIZE, b, T0 + 2 * H);
    if (e2.kind !== 'opened') throw new Error();
    sim.onTrade('SOL-25SEP26-CDE', e2.position.targetPrice, 100, T0 + 3 * H, b);   // win
    const s = paperStats(sim.closed, 25_000);
    expect(s.n).toBe(2); expect(s.byReason).toEqual({ stop: 1, target: 1 });
    expect(s.winRate).toBe(0.5);
    expect(s.maxDrawdownUsd).toBeGreaterThan(500);                                  // the loss + fees
    expect(s.equity).toBeCloseTo(25_000 + s.pnlUsd, 6);
    expect(s.profitFactor).toBeGreaterThan(1);
  });
});

describe('intentsFromBook — the bot trades only what the app would have shown', () => {
  const row = (asset: string, dir: string, ev: number, risk = 0.02) => ({
    candidate: { asset, direction: dir, entryPrice: 100, stopPrice: dir === 'SHORT' ? 102 : 98, targetPrice: dir === 'SHORT' ? 90 : 110, payoff: { expectedValueR: ev } },
    sizing: { riskFraction: risk },
  });
  it('SHORT above the floor becomes an intent with the row geometry and the risk budget in dollars', () => {
    const { intents, skipped } = intentsFromBook([row('SOLUSDT', 'SHORT', 0.07)], 40, 25_000);
    expect(skipped).toEqual([]);
    expect(intents[0]).toMatchObject({ symbol: 'SOLUSDT', stopDistance: 2, targetDistance: 10, riskUsd: 500, holdMs: 72 * H });
  });
  it('LONG, sub-floor EV, and greed are gated with plain reasons; a genuine 50 mood does not gate', () => {
    const { intents, skipped } = intentsFromBook([row('BTCUSDT', 'LONG', 0.3), row('ETHUSDT', 'SHORT', 0.04), row('XRPUSDT', 'SHORT', 0.09)], 75, 25_000);
    expect(intents).toEqual([]);
    expect(skipped.map(s => s.reason)).toEqual([expect.stringMatching(/only SHORT/), expect.stringMatching(/under the 0.05R floor/), expect.stringMatching(/greed/)]);
    expect(intentsFromBook([row('XRPUSDT', 'SHORT', 0.09)], 50, 25_000).intents.length).toBe(1);
    expect(intentsFromBook([row('XRPUSDT', 'SHORT', 0.09)], null, 25_000).intents.length).toBe(1);
  });
});
