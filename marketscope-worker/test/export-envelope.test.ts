import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { assertJoinsV14, joinToV14, applyKeepMask, exportEnvelope, type V14Row } from '../scripts/exportEnvelope';

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

describe('separating an archive blip from a dirty tail', () => {
  // The two failure modes the real archive produces need opposite treatment, and DENSITY is what
  // tells them apart. A single bad bar should cost that bar; a region that goes bad and stays bad
  // should be truncated away; a slice error is bad everywhere and must fail the symbol outright.
  const clean = (n: number) => Array.from({ length: n }, (_, k) => v14(100 * (k + 1), 10 + k, 50, 50, 20));
  const mineRows = (n: number, bad: Record<number, number> = {}) =>
    csv(...Array.from({ length: n }, (_, k) => row(100 * (k + 1), bad[k] ?? (10 + k), 50, 50, 20)));

  it('drops one blip and keeps everything around it', () => {
    const j = joinToV14('BTCUSDT', mineRows(40, { 12: 99 }), clean(40));
    expect(j.kept).toBe(39);
    expect(j.dropped.map(d => d.ts)).toEqual([1300]);
    expect(j.truncatedAt).toBeNull();
    expect(j.longestBadRun).toBe(1);
  });

  it('truncates a run that goes bad and stays bad, rather than cherry-picking through it', () => {
    const bad: Record<number, number> = {};
    for (let k = 20; k < 40; k++) bad[k] = 99;         // 20 consecutive = the dirty-tail signature
    const j = joinToV14('BTCUSDT', mineRows(40, bad), clean(40));
    expect(j.truncatedAt).toBe(2100);
    expect(j.kept).toBe(20);
    expect(j.dropped).toEqual([]);                      // truncated, not counted as blips
  });

  it('a slice error is bad on every row, so it truncates to nothing', () => {
    const bad: Record<number, number> = {};
    for (let k = 0; k < 40; k++) bad[k] = 99;
    const j = joinToV14('BTCUSDT', mineRows(40, bad), clean(40));
    expect(j.kept).toBe(0);
    expect(j.truncatedAt).toBe(100);
  });

  it('reports a fully clean join', () => {
    const j = joinToV14('BTCUSDT', mineRows(40), clean(40));
    expect(j.kept).toBe(40);
    expect(j.truncatedAt).toBeNull();
    expect(j.dropped).toEqual([]);
  });

  it('keeps the mask aligned with the rows it describes', () => {
    const j = joinToV14('BTCUSDT', mineRows(10, { 3: 99 }), clean(10));
    const out = applyKeepMask(mineRows(10, { 3: 99 }), j.keepMask).trim().split('\n').slice(1);
    expect(out).toHaveLength(9);
    expect(out.some(l => l.split(',')[1] === '400')).toBe(false);
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
