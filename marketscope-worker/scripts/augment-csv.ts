#!/usr/bin/env tsx
// Augments existing BacktestEngine-generated CSVs with two new columns:
//   fwdMaxFavR48H — max favorable excursion in ATR multiples over the next 12 4H bars
//   fwdMaxFavR72H — same, over the next 18 4H bars
//
// The Swift BacktestEngine doesn't compute these (only fwdMaxFavR for 24h). For the
// persistence-correlation experiment we need them, but we don't want to re-run the
// 4-hour sim sweep. So we re-fetch the original 4H candles from Binance, match each
// CSV row's timestamp to a candle index, and compute the new windows from there.
//
// Usage:
//   npm run augment -- --src /path/to/swift_csvs --dst /path/to/augmented [--concurrency 8]

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import pLimit from 'p-limit';
import type { Candle } from '../src/scoring-full.js';
import { fetchBinanceKlines } from './fetchers/candles-binance.js';

const FOUR_H_MS = 14_400_000;

interface AugOpts {
    srcDir: string;
    dstDir: string;
    concurrency: number;
}

function parseArgs(argv: string[]): AugOpts {
    const opts: Record<string, string> = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) opts[k] = 'true';
        else { opts[k] = v; i++; }
    }
    if (!opts.src || !opts.dst) throw new Error('Required: --src DIR --dst DIR');
    return {
        srcDir: opts.src,
        dstDir: opts.dst,
        concurrency: Math.max(1, parseInt(opts.concurrency ?? '8', 10)),
    };
}

function fwdMaxFavR(candles: Candle[], i: number, lookahead: number, atr: number): number {
    if (atr <= 0) return 0;
    const end = Math.min(i + lookahead, candles.length - 1);
    if (end <= i) return 0;
    const price = candles[i].close;
    let maxHigh = -Infinity, minLow = Infinity;
    for (let k = i + 1; k <= end; k++) {
        if (candles[k].high > maxHigh) maxHigh = candles[k].high;
        if (candles[k].low < minLow) minLow = candles[k].low;
    }
    if (maxHigh === -Infinity) return 0;
    return Math.max(maxHigh - price, price - minLow) / atr;
}

async function augmentOne(srcPath: string, dstPath: string): Promise<{ rows: number; matched: number }> {
    const text = await readFile(srcPath, 'utf8');
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('Empty CSV');

    const header = lines[0];
    const cols = header.split(',');
    const idx = (name: string) => {
        const i = cols.indexOf(name);
        if (i < 0) throw new Error(`Missing column ${name} in ${srcPath}`);
        return i;
    };
    const cSym = idx('symbol');
    const cTs = idx('timestamp');
    const cPrice = idx('price');
    const cAtrPct = idx('atrPercent');

    const rows = lines.slice(1).map(l => l.split(','));
    const symbol = rows[0][cSym];
    // Swift CSVs write `timestamp` in **seconds** (BacktestEngine.swift:1618 uses
    // Int(timeIntervalSince1970)); Binance returns candle times in ms. Convert at
    // the boundary so the timestamp→index map below matches.
    const startMs = parseInt(rows[0][cTs], 10) * 1000;
    const endMs = parseInt(rows[rows.length - 1][cTs], 10) * 1000 + 19 * FOUR_H_MS;

    const fourH = await fetchBinanceKlines(symbol, '4h', startMs, endMs);
    const tsToIdx = new Map<number, number>();
    fourH.forEach((c, i) => tsToIdx.set(c.time, i));

    const newHeader = header + ',fwdMaxFavR48H,fwdMaxFavR72H';
    let matched = 0;
    const newRows: string[] = [];
    for (const row of rows) {
        const ts = parseInt(row[cTs], 10) * 1000;  // seconds → ms
        const idxBar = tsToIdx.get(ts);
        const price = parseFloat(row[cPrice]);
        const atrPct = parseFloat(row[cAtrPct]);
        const atrFor4H = (atrPct / 100) * price;
        let f48 = 0, f72 = 0;
        if (idxBar !== undefined && atrFor4H > 0) {
            matched++;
            f48 = fwdMaxFavR(fourH, idxBar, 12, atrFor4H);
            f72 = fwdMaxFavR(fourH, idxBar, 18, atrFor4H);
        }
        newRows.push(row.join(',') + ',' + f48.toFixed(4) + ',' + f72.toFixed(4));
    }

    await mkdir(join(dstPath, '..'), { recursive: true });
    await writeFile(dstPath, [newHeader, ...newRows].join('\n') + '\n');
    return { rows: rows.length, matched };
}

async function main() {
    const opts = parseArgs(process.argv);
    const files = (await readdir(opts.srcDir)).filter(f => f.endsWith('USDT.csv'));
    if (files.length === 0) {
        throw new Error(`No *USDT.csv files in ${opts.srcDir}`);
    }
    console.log(`[augment] ${files.length} files, concurrency=${opts.concurrency}`);
    await mkdir(opts.dstDir, { recursive: true });

    const limit = pLimit(opts.concurrency);
    const t0 = Date.now();
    const results = await Promise.allSettled(
        files.map(f => limit(async () => {
            const t = Date.now();
            try {
                const r = await augmentOne(join(opts.srcDir, f), join(opts.dstDir, f));
                const dt = ((Date.now() - t) / 1000).toFixed(1);
                console.log(`[${basename(f, '.csv')}] ✓ ${r.matched}/${r.rows} matched (${dt}s)`);
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
    console.log(`\n[augment] ${ok}/${results.length} succeeded in ${totalSec}s${failed ? ` (${failed} failed)` : ''}`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
