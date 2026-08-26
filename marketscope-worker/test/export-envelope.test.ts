import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { assertJoinsV14, joinToV14, exportEnvelope, type V14Row } from '../scripts/exportEnvelope';

// The exporter's join gate. It is what makes a per-bar envelope verdict usable as research data:
// unless this run's bars line up with the rows the model was trained on, any statistic computed
// from the two together is describing a mixture of populations.
//
// The gate checks slice-SENSITIVE columns, not just price. Price is read off the bar, so it agrees
// even when the indicator windows are wrong — verified: a `fourHAll.slice(i-300, i)` mutation passed
// a price-only check silently. `dRsi`, `hRsi` and `atrPercentile` each come from a different window.

const HEAD = 'symbol,timestamp,price,maxAllowed,dRsi,hRsi,atrPct';
const row = (ts: number, px: number, dRsi: number, hRsi: number, atr: number) =>
  `BTCUSDT,${ts},${px.toFixed(4)},HIGH,${dRsi.toFixed(4)},${hRsi.toFixed(4)},${atr.toFixed(4)}`;
const csv = (...rows: string[]) => [HEAD, ...rows].join('\n');
const v14 = (ts: number, price: number, dRsi: number, hRsi: number, atrPercentile: number): V14Row =>
  ({ ts, price, dRsi, hRsi, atrPercentile });

describe('the v14 join gate', () => {
  const good = [v14(100, 7225.01, 46.4, 45.3, 20), v14(200, 7209.83, 46.4, 43.7, 20)];

  it('accepts an aligned export', () => {
    const r = assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.37, 45.27, 20)), good);
    expect(r.matched).toBe(1);
    expect(r.v14Only).toBe(1);      // the export covered only part of v14's range
  });

  it('rejects a bar v14 does not have — the eval window differs', () => {
    expect(() => assertJoinsV14('BTCUSDT', csv(row(150, 7225.01, 46.37, 45.27, 20)), good))
      .toThrow(/bar absent from csv_exports_v14/);
  });

  it('rejects a price disagreement — the candle archives differ', () => {
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7300, 46.37, 45.27, 20)), good))
      .toThrow(/local candle archive disagrees/);
  });

  it('rejects a 4H slice shift that price alone would not catch', () => {
    // The exact mutation that slipped through the first version of this gate.
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.37, 41.48, 20)), good))
      .toThrow(/hRsi 45\.3 vs 41\.4800 — indicator window differs/);
  });

  it('rejects a daily slice that stops dropping the in-progress day', () => {
    // Restoring the 2026-06-02 leak is the single most expensive mistake available here: it is what
    // produced the retracted 94% direction claim. It moves dRsi and nothing else visible.
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.55, 45.27, 20)), good))
      .toThrow(/dRsi 46\.4 vs 46\.5500/);
  });

  it('rejects a changed daily population window', () => {
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.37, 45.27, 3)), good))
      .toThrow(/atrPercentile 20 vs 3/);
  });

  it('tolerates v14 rounding to 1 dp but not a real divergence', () => {
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.44, 45.34, 20)), good)).not.toThrow();
    expect(() => assertJoinsV14('BTCUSDT', csv(row(100, 7225.01, 46.6, 45.27, 20)), good)).toThrow(/dRsi 46\.4 vs 46\.6/);
  });

  it('refuses an empty export instead of reporting a vacuous success', () => {
    // 0 rows joined against 0 rows is trivially consistent, and was the first thing this script did.
    expect(() => assertJoinsV14('BTCUSDT', csv(), good)).toThrow(/exported 0 rows/);
  });
});

describe('the prefix report, which is how a dirty archive tail is handled honestly', () => {
  // The box's D1 snapshot carries mid-bar cron writes near its recent end, so a symbol is clean for
  // years and then is not. All-or-nothing would discard five good years to avoid two bad months.
  const three = [v14(100, 10, 50, 50, 20), v14(200, 20, 50, 50, 20), v14(300, 30, 50, 50, 20)];

  it('reports how many rows agreed before the first divergence', () => {
    const j = joinToV14('BTCUSDT', csv(
      row(100, 10, 50, 50, 20),
      row(200, 20, 50, 50, 20),
      row(300, 33, 50, 50, 20),        // a partial bar, as the real archive produces
    ), three);
    expect(j.matched).toBe(2);
    expect(j.firstBadTs).toBe(300);
    expect(j.reason).toMatch(/local candle archive disagrees/);
  });

  it('reports a clean join with no truncation point', () => {
    const j = joinToV14('BTCUSDT', csv(row(100, 10, 50, 50, 20), row(200, 20, 50, 50, 20)), three);
    expect(j.matched).toBe(2);
    expect(j.firstBadTs).toBeNull();
    expect(j.reason).toBeNull();
  });

  it('a divergence on the FIRST row yields a zero-length prefix, not a pass', () => {
    const j = joinToV14('BTCUSDT', csv(row(100, 99, 50, 50, 20)), three);
    expect(j.matched).toBe(0);
  });
});

// Data-dependent: `marketscope.db` (1 GB box snapshot) and `csv_exports_v14/` are both gitignored,
// so this cannot run in CI. It runs on a developer machine, where it is the end-to-end check.
const hasData = existsSync('marketscope.db')
  && existsSync(join('..', 'ml-training', 'csv_exports_v14', 'BTCUSDT.csv'));

describe.skipIf(!hasData)('end to end against the real archive', () => {
  it('exports BTC bars that join to v14 on every checked column', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database('marketscope.db', { readonly: true });
    const res = exportEnvelope(db, 'BTCUSDT', { limit: 120 });
    expect(res.rows).toBeGreaterThan(100);
    const j = assertJoinsV14('BTCUSDT', res.csv);
    expect(j.matched).toBe(res.rows);
    // Every bar must carry a verdict — a blank would mean the envelope block did not run.
    const tiers = res.csv.trim().split('\n').slice(1).map(l => l.split(',')[5]);
    expect(tiers.every(t => ['FLAT', 'LOW', 'MODERATE', 'HIGH'].includes(t))).toBe(true);
    db.close();
  }, 60_000);
});
