// Liquidation collector (server/liquidations.ts) + read path (fetchLiquidationSummary,
// prompt line). The websocket itself can't run in tests — parseForceOrder and the D1 glue
// are the testable surface; the stream is just plumbing between them.
import { describe, it, expect } from 'vitest';
import { D1Adapter } from '../server/d1-adapter';
import { parseForceOrder, flushLiquidations, ensureLiquidationsTable, type LiquidationRow } from '../server/liquidations';
import { fetchLiquidationSummary } from '../src/index';
import { buildUserPrompt, type PromptIndicator } from '../src/prompt';
import { computeFullIndicators } from '../src/indicators-full';
import type { Candle } from '../src/scoring-full';

// A real forceOrder frame shape (Binance USDⓈ-M docs).
const FRAME = {
  e: 'forceOrder', E: 1_700_000_000_000,
  o: { s: 'BTCUSDT', S: 'SELL', o: 'LIMIT', f: 'IOC', q: '0.014', p: '9910', ap: '9910',
       X: 'FILLED', l: '0.014', z: '0.014', T: 1_700_000_000_123 },
};

describe('parseForceOrder', () => {
  it('parses a FILLED long liquidation (SELL order = long force-closed)', () => {
    const row = parseForceOrder(FRAME)!;
    expect(row.symbol).toBe('BTCUSDT');
    expect(row.side).toBe('long');
    expect(row.price).toBeCloseTo(9910, 5);
    expect(row.qty).toBeCloseTo(0.014, 8);
    expect(row.notional).toBeCloseTo(9910 * 0.014, 5);
    expect(row.ts).toBe(1_700_000_000_123);
  });

  it('BUY order = short liquidated', () => {
    const row = parseForceOrder({ ...FRAME, o: { ...FRAME.o, S: 'BUY' } })!;
    expect(row.side).toBe('short');
  });

  it('rejects partial fills, non-USDT symbols, and junk', () => {
    expect(parseForceOrder({ ...FRAME, o: { ...FRAME.o, X: 'PARTIALLY_FILLED' } })).toBeNull();
    expect(parseForceOrder({ ...FRAME, o: { ...FRAME.o, s: 'BTCUSD_PERP' } })).toBeNull();
    expect(parseForceOrder({ e: 'aggTrade' })).toBeNull();
    expect(parseForceOrder(null)).toBeNull();
    expect(parseForceOrder({ ...FRAME, o: { ...FRAME.o, ap: '0' } })).toBeNull();
  });
});

describe('flush + summary (D1 glue)', () => {
  function rows(now: number): LiquidationRow[] {
    return [
      // 1h window: $2M longs, $0.5M shorts
      { symbol: 'BTCUSDT', ts: now - 30 * 60_000, side: 'long', price: 100, qty: 20_000, notional: 2_000_000 },
      { symbol: 'BTCUSDT', ts: now - 10 * 60_000, side: 'short', price: 100, qty: 5_000, notional: 500_000 },
      // older but inside 24h: +$1M longs
      { symbol: 'BTCUSDT', ts: now - 5 * 3_600_000, side: 'long', price: 100, qty: 10_000, notional: 1_000_000 },
      // outside 24h: excluded
      { symbol: 'BTCUSDT', ts: now - 30 * 3_600_000, side: 'long', price: 100, qty: 99_999, notional: 9_999_900 },
      // other symbol: excluded
      { symbol: 'ETHUSDT', ts: now - 5 * 60_000, side: 'short', price: 10, qty: 100, notional: 1_000 },
    ];
  }

  it('aggregates 1h/24h by liquidated side, per symbol', async () => {
    const env = { DB: new D1Adapter(':memory:'), ALERTS: { get: async () => null } } as any;
    const now = Date.now();
    await flushLiquidations(env, rows(now));
    const s = (await fetchLiquidationSummary(env, 'BTCUSDT'))!;
    expect(s.h1LongUsd).toBeCloseTo(2_000_000, 0);
    expect(s.h1ShortUsd).toBeCloseTo(500_000, 0);
    expect(s.h24LongUsd).toBeCloseTo(3_000_000, 0);   // 1h rows are inside 24h too
    expect(s.h24ShortUsd).toBeCloseTo(500_000, 0);
  });

  it('returns null when there is no data (or no table yet)', async () => {
    const env = { DB: new D1Adapter(':memory:'), ALERTS: { get: async () => null } } as any;
    expect(await fetchLiquidationSummary(env, 'BTCUSDT')).toBeNull();   // table absent
    await ensureLiquidationsTable(env);
    expect(await fetchLiquidationSummary(env, 'BTCUSDT')).toBeNull();   // table empty
  });
});

describe('prompt line', () => {
  function synthCandles(n: number, startMs: number, stepMs: number, base = 100): Candle[] {
    const out: Candle[] = [];
    let price = base;
    for (let i = 0; i < n; i++) {
      const drift = Math.sin(i / 9) * 2 + i * 0.03;
      const open = price, close = base + drift;
      out.push({ time: startMs + i * stepMs, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, volume: 1000 + (i % 7) * 120 });
      price = close;
    }
    return out;
  }

  it('renders the LIQUIDATIONS line with the interpretation when 1h flow is one-sided', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')],
      liquidations: { h1LongUsd: 2_000_000, h1ShortUsd: 300_000, h24LongUsd: 8_500_000, h24ShortUsd: 1_200_000 },
    });
    expect(prompt).toContain('LIQUIDATIONS (observed, Binance futures');
    expect(prompt).toContain('$2.0M longs / $300k shorts');
    expect(prompt).toContain('$8.5M / $1.2M');
    expect(prompt).toContain('LONG liquidations = forced SELLING');
    expect(prompt).toContain('lower bounds');
  });

  it('omits the line entirely without data', () => {
    const NOW = 1748736000000, DAY = 86400000, H4 = 4 * 3600 * 1000, H1 = 3600 * 1000;
    const mk = (n: number, step: number, label: string, tf: string) =>
      computeFullIndicators(synthCandles(n, NOW - n * step, step, 100), { timeframe: tf, label, isCrypto: true }) as unknown as PromptIndicator;
    const { prompt } = buildUserPrompt({
      symbol: 'BTCUSDT', nowMs: NOW, indicators: [mk(230, DAY, 'Daily (1D)', '1d'), mk(230, H4, '4H', '4h'), mk(120, H1, '1H', '1h')],
    });
    expect(prompt).not.toContain('LIQUIDATIONS (observed');
  });
});
