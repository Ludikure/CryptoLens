#!/usr/bin/env tsx
// Adds fwdReturn48H + fwdReturn72H to existing CSVs that pre-date the 2026-05-08
// runBacktest update. Re-fetches 4H candles, indexes by timestamp, computes signed
// close-to-close returns at +12 and +18 4H bars.
//
// Idempotent: if columns already exist (CSV produced post-update) the file is left
// untouched.
//
// Usage:
//   npx tsx scripts/augment-fwd-returns.ts --src /path/to/csv_exports_node [--concurrency 4]

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import pLimit from 'p-limit';
import type { Candle } from '../src/scoring-full.js';
import { fetchBinanceKlines } from './fetchers/candles-binance.js';
import { fetchYahoo1H } from './fetchers/yahoo.js';
import { fetchD1Candles } from './fetchers/candles-d1.js';
import { aggregate1HTo4H_ET } from '../src/aggregation.js';

const FOUR_H_MS = 14_400_000;
const YAHOO_1H_LIMIT_MS = 720 * 86_400_000;

interface Opts { srcDir: string; concurrency: number; }

function parseArgs(argv: string[]): Opts {
    const opts: Record<string, string> = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) opts[k] = 'true';
        else { opts[k] = v; i++; }
    }
    if (!opts.src) throw new Error('Required: --src DIR');
    return { srcDir: opts.src, concurrency: Math.max(1, parseInt(opts.concurrency ?? '4', 10)) };
}

async function fetch4HStock(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
    // Same stitching strategy runBacktest.ts uses for stocks — Yahoo 1H for the
    // recent ≤720d, D1 for older history, then aggregate to 4H ET.
    const yahooCutoff = Math.max(startMs, endMs - YAHOO_1H_LIMIT_MS + 86_400_000);
    const [yahoo, d1] = await Promise.all([
        fetchYahoo1H(symbol, yahooCutoff, endMs).catch(() => [] as Candle[]),
        startMs < yahooCutoff
            ? fetchD1Candles(symbol, '1h', startMs, yahooCutoff)
            : Promise.resolve([] as Candle[]),
    ]);
    const seen = new Set(yahoo.map(c => c.time));
    const merged = [...d1.filter(c => !seen.has(c.time)), ...yahoo];
    merged.sort((a, b) => a.time - b.time);
    return aggregate1HTo4H_ET(merged);
}

function returnAtBars(candles: Candle[], i: number, bars: number): number {
    const last = candles.length - 1;
    const price = candles[i].close;
    const k = Math.min(i + bars, last);
    return ((candles[k].close - price) / price) * 100;
}

async function augmentOne(srcPath: string): Promise<{ symbol: string; rows: number; matched: number; skipped: boolean }> {
    const text = await readFile(srcPath, 'utf8');
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('Empty CSV');
    const header = lines[0];
    const cols = header.split(',');
    if (cols.includes('fwdReturn48H') && cols.includes('fwdReturn72H')) {
        return { symbol: basename(srcPath, '.csv'), rows: lines.length - 1, matched: 0, skipped: true };
    }

    const idx = (name: string) => {
        const i = cols.indexOf(name);
        if (i < 0) throw new Error(`Missing column ${name} in ${srcPath}`);
        return i;
    };
    const cSym = idx('symbol');
    const cTs = idx('timestamp');

    const rows = lines.slice(1).map(l => l.split(','));
    const symbol = rows[0][cSym];
    const isCrypto = symbol.endsWith('USDT');

    // CSV timestamps are seconds (post-2026-05-08 csv.ts) or ms (older). Auto-detect
    // and normalize to ms for the candle index map.
    const firstTsRaw = parseInt(rows[0][cTs], 10);
    const tsScale = firstTsRaw > 1e11 ? 1 : 1000;
    const startMs = parseInt(rows[0][cTs], 10) * tsScale;
    const endMs = parseInt(rows[rows.length - 1][cTs], 10) * tsScale + 19 * FOUR_H_MS;

    const fourH = isCrypto
        ? await fetchBinanceKlines(symbol, '4h', startMs, endMs)
        : await fetch4HStock(symbol, startMs, endMs);
    const tsToIdx = new Map<number, number>();
    fourH.forEach((c, i) => tsToIdx.set(c.time, i));

    let matched = 0;
    const newRows: string[] = [];
    for (const row of rows) {
        const tsMs = parseInt(row[cTs], 10) * tsScale;
        const idxBar = tsToIdx.get(tsMs);
        let r48 = 0, r72 = 0;
        if (idxBar !== undefined) {
            matched++;
            r48 = returnAtBars(fourH, idxBar, 12);
            r72 = returnAtBars(fourH, idxBar, 18);
        }
        newRows.push(row.join(',') + ',' + r48.toFixed(4) + ',' + r72.toFixed(4));
    }

    const newHeader = header + ',fwdReturn48H,fwdReturn72H';
    await writeFile(srcPath, [newHeader, ...newRows].join('\n') + '\n');
    return { symbol, rows: rows.length, matched, skipped: false };
}

async function main() {
    const opts = parseArgs(process.argv);
    const files = (await readdir(opts.srcDir)).filter(f => f.endsWith('.csv'));
    if (files.length === 0) throw new Error(`No .csv files in ${opts.srcDir}`);
    console.log(`[augment-fwd] ${files.length} files, concurrency=${opts.concurrency}`);

    const limit = pLimit(opts.concurrency);
    const t0 = Date.now();
    const results = await Promise.allSettled(
        files.map(f => limit(async () => {
            const t = Date.now();
            try {
                const r = await augmentOne(join(opts.srcDir, f));
                const dt = ((Date.now() - t) / 1000).toFixed(1);
                if (r.skipped) console.log(`[${r.symbol}] – already has columns (${dt}s)`);
                else console.log(`[${r.symbol}] ✓ ${r.matched}/${r.rows} matched (${dt}s)`);
                return r;
            } catch (e) {
                const dt = ((Date.now() - t) / 1000).toFixed(1);
                console.error(`[${basename(f, '.csv')}] ✗ ${e instanceof Error ? e.message : e} (${dt}s)`);
                throw e;
            }
        })),
    );

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[augment-fwd] ${ok}/${results.length} succeeded in ${totalSec}s${failed ? ` (${failed} failed)` : ''}`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
