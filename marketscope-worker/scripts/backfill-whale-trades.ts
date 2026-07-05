// Backfill historical whale-trade flow from Binance Vision public data dumps.
//
// WHY: the live cron archives large_* (whale aggTrade flow) to derivatives_history, but that
// archive only accumulates forward from when it started. Binance's REST API can't reconstruct
// history (aggTrades pagination is impractical at scale, OI history caps at 30d) — but
// data.binance.vision hosts FULL historical daily aggTrades dumps for USDT-M futures, free, no
// auth. This script rebuilds per-4h-bar whale flow for the whole training window, so the
// whale-feature hypothesis can be walk-forward tested NOW instead of after a year of archiving.
//
// Definition of "whale" = one aggTrade with >= $100k USD notional (WHALE_NOTIONAL_USD in
// src/index.ts — keep in sync). is_buyer_maker=true means the AGGRESSOR was a seller.
//
// Output: one CSV per symbol under --out (default ml-training/whale_backfill/):
//   timestamp,large_buy_vol,large_sell_vol,large_buy_count,large_sell_count
// timestamp = 4h bucket OPEN in ms UTC (aligned with Binance 4h candle opens 00/04/08/12/16/20).
//
// Resumable: on restart it reads the existing CSV's last timestamp and continues from the next
// day. A 404 day (symbol not yet listed) is skipped silently.
//
// SCALE WARNING: majors are heavy — BTCUSDT daily zips run ~50–150 MB, so 2 years of BTC is a
// ~60–100 GB download (processed streaming; disk holds only one day's zip at a time). Run
// per-symbol / overnight. Illiquid alts are a few MB/day.
//
// Usage:
//   npx tsx scripts/backfill-whale-trades.ts --symbols BTCUSDT,ETHUSDT --start 2024-07-01
//   npx tsx scripts/backfill-whale-trades.ts --symbols SOLUSDT --start 2022-01-01 --end 2026-07-01
//
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendFileSync } from 'node:fs';

const WHALE_NOTIONAL_USD = 100_000; // keep in sync with src/index.ts
const FOUR_H_MS = 4 * 3600_000;

// ---- args ----
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const symbols = arg('symbols', 'BTCUSDT,ETHUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const defaultStart = new Date(Date.now() - 2 * 365 * 86400_000).toISOString().slice(0, 10);
const defaultEnd = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10); // dumps lag ~1 day
const startDate = arg('start', defaultStart);
const endDate = arg('end', defaultEnd);
const outDir = arg('out', join(import.meta.dirname ?? '.', '..', '..', 'ml-training', 'whale_backfill'));
const threshold = parseFloat(arg('threshold', String(WHALE_NOTIONAL_USD)));

function* days(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { yield d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
}

type Bucket = { buyVol: number; sellVol: number; buyCount: number; sellCount: number };

async function processDay(symbol: string, date: string): Promise<Map<number, Bucket> | null> {
  const url = `https://data.binance.vision/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${date}.zip`;
  const res = await fetch(url);
  if (res.status === 404) return null;               // symbol not listed yet that day
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);

  // Download to a temp file, then stream-parse via `unzip -p` (no full-file memory).
  const tmp = join(tmpdir(), `${symbol}-${date}.zip`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));

  const buckets = new Map<number, Bucket>();
  try {
    const unzip = spawn('unzip', ['-p', tmp]);
    const rl = createInterface({ input: unzip.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      // Columns: agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
      // Newer dumps carry a header row — skip any line whose first field isn't numeric.
      const c = line.split(',');
      if (c.length < 7 || !/^\d/.test(c[0])) continue;
      const price = parseFloat(c[1]), qty = parseFloat(c[2]);
      const notional = price * qty;
      if (!(notional >= threshold)) continue;
      const ts = parseInt(c[5], 10);
      const bucket = Math.floor(ts / FOUR_H_MS) * FOUR_H_MS;
      let b = buckets.get(bucket);
      if (!b) { b = { buyVol: 0, sellVol: 0, buyCount: 0, sellCount: 0 }; buckets.set(bucket, b); }
      if (c[6].trim().toLowerCase().startsWith('t')) { b.sellVol += notional; b.sellCount++; }  // buyer-maker = sell aggressor
      else { b.buyVol += notional; b.buyCount++; }
    }
    await new Promise<void>((resolve, reject) => {
      unzip.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`)));
      unzip.on('error', reject);
    });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  return buckets;
}

function lastTimestampIn(csvPath: string): number {
  if (!existsSync(csvPath)) return 0;
  const content = readFileSync(csvPath, 'utf8').trimEnd();
  const lastLine = content.slice(content.lastIndexOf('\n') + 1);
  const ts = parseInt(lastLine.split(',')[0], 10);
  return Number.isFinite(ts) ? ts : 0;
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  console.log(`Whale backfill: ${symbols.join(', ')} | ${startDate} → ${endDate} | >= $${threshold.toLocaleString()} | out: ${outDir}`);

  for (const symbol of symbols) {
    const csvPath = join(outDir, `${symbol}.csv`);
    const resumeTs = lastTimestampIn(csvPath);
    if (!existsSync(csvPath)) {
      appendFileSync(csvPath, 'timestamp,large_buy_vol,large_sell_vol,large_buy_count,large_sell_count\n');
    }
    let done = 0, skipped = 0;
    for (const date of days(startDate, endDate)) {
      const dayStart = Date.parse(`${date}T00:00:00Z`);
      if (dayStart + 86400_000 - FOUR_H_MS <= resumeTs) { skipped++; continue; }  // already have this day
      let buckets: Map<number, Bucket> | null = null;
      for (let attempt = 1; ; attempt++) {
        try { buckets = await processDay(symbol, date); break; }
        catch (e: any) {
          if (attempt >= 3) { console.error(`  ${symbol} ${date}: FAILED after 3 attempts (${e.message}) — stopping this symbol so resume stays contiguous`); buckets = undefined as any; break; }
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (buckets === undefined as any) break;        // hard failure → stop symbol (resumable later)
      if (buckets === null) { skipped++; continue; }  // 404 (not listed yet)
      const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0])
        .map(([ts, b]) => `${ts},${b.buyVol.toFixed(0)},${b.sellVol.toFixed(0)},${b.buyCount},${b.sellCount}`);
      if (rows.length) appendFileSync(csvPath, rows.join('\n') + '\n');
      done++;
      if (done % 20 === 0) console.log(`  ${symbol}: ${done} days processed (through ${date})`);
    }
    console.log(`${symbol}: done (${done} days processed, ${skipped} skipped)`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
