#!/usr/bin/env tsx
// Persistence-correlation experiment.
//
// Question: does the existing 24h-trained ML model's prediction correlate with
// max-favorable excursion at longer windows (48h, 72h)?
//
// Method:
//   1. Score each historical bar with the existing crypto model JSON.
//   2. Bucket bars by predicted ML probability.
//   3. For each bucket, compute average + hit-rate of fwdMaxFavR at 24h, 48h, 72h.
//
// Reading the output:
//   - If high-ML buckets show elevated max-fav across all three windows → model
//     captures longer-window persistence. No second model needed.
//   - If only 24h is elevated and 72h flattens → model is myopic; a second head
//     trained on `fwdMaxFavR72H >= 1.5` is justified.
//
// Usage:
//   npm run persistence -- --src /tmp/csv_augmented [--symbol BTCUSDT]

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { mlPredict } from '../src/ml-predict.js';

interface Args {
    srcDir: string;
    symbolFilter?: string;
}

function parseArgs(argv: string[]): Args {
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
    return { srcDir: opts.src, symbolFilter: opts.symbol };
}

interface BucketStats {
    n: number;
    sumFav24: number; sumFav48: number; sumFav72: number;
    hit24: number; hit48: number; hit72: number;  // count of fwdMaxFavR >= 1.5
    sum2_24: number; sum2_48: number; sum2_72: number;  // hit-2.0 ATR threshold
    /// Direction-agreement counters. Populated only when the CSV has fwdReturn48H/72H
    /// columns (post 2026-05-08 augmentation). nDirAware is the denominator for the
    /// agree48/72 ratios — bars where both 24h and the longer horizon have a
    /// significant return (>0.3% to filter noise) so the sign comparison is meaningful.
    nDirAware: number;
    agree48: number; agree72: number;
}

function emptyBucket(): BucketStats {
    return {
        n: 0, sumFav24: 0, sumFav48: 0, sumFav72: 0,
        hit24: 0, hit48: 0, hit72: 0,
        sum2_24: 0, sum2_48: 0, sum2_72: 0,
        nDirAware: 0, agree48: 0, agree72: 0,
    };
}

function bucketKey(p: number): string {
    if (p < 0.30) return '<30%';
    if (p < 0.50) return '30-50%';
    if (p < 0.60) return '50-60%';
    if (p < 0.70) return '60-70%';
    if (p < 0.85) return '70-85%';
    return '85%+';
}

const ORDER = ['<30%', '30-50%', '50-60%', '60-70%', '70-85%', '85%+'];

async function processCsv(
    path: string,
    cryptoBuckets: Map<string, BucketStats>,
    stockBuckets: Map<string, BucketStats>,
): Promise<{ rows: number; sym: string }> {
    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    const cols = lines[0].split(',');
    const idxMap: Record<string, number> = {};
    cols.forEach((c, i) => { idxMap[c] = i; });
    const required = ['fwdMaxFavR', 'fwdMaxFavR48H', 'fwdMaxFavR72H', 'isCrypto'];
    for (const r of required) if (!(r in idxMap)) throw new Error(`Missing column ${r} in ${path}`);
    // Direction-agreement columns are optional — populated by augment-fwd-returns.ts
    // for older CSVs, written natively by post-2026-05-08 runBacktest.
    const hasDirCols = 'fwdReturn24H' in idxMap && 'fwdReturn48H' in idxMap && 'fwdReturn72H' in idxMap;

    let rows = 0;
    let sym = '';
    for (let li = 1; li < lines.length; li++) {
        const fields = lines[li].split(',');
        if (fields.length < cols.length) continue;
        sym = fields[idxMap.symbol];
        const isCrypto = fields[idxMap.isCrypto] === '1';

        // Build feature dict from row (all numeric columns the model expects).
        const input: Record<string, number> = {};
        for (let ci = 0; ci < cols.length; ci++) {
            const v = parseFloat(fields[ci]);
            if (!Number.isNaN(v)) input[cols[ci]] = v;
        }

        // Score against the matching model (crypto vs stock heads share the
        // mlPredict entrypoint with an isCrypto flag).
        const prob = mlPredict(input, isCrypto);
        const fav24 = parseFloat(fields[idxMap.fwdMaxFavR]);
        const fav48 = parseFloat(fields[idxMap.fwdMaxFavR48H]);
        const fav72 = parseFloat(fields[idxMap.fwdMaxFavR72H]);
        if (!Number.isFinite(fav24) || !Number.isFinite(fav48) || !Number.isFinite(fav72)) continue;
        if (fav24 === 0 && fav48 === 0 && fav72 === 0) continue;  // forward windows cut off near series end

        const buckets = isCrypto ? cryptoBuckets : stockBuckets;
        const k = bucketKey(prob);
        let b = buckets.get(k);
        if (!b) { b = emptyBucket(); buckets.set(k, b); }
        b.n++;
        b.sumFav24 += fav24; b.sumFav48 += fav48; b.sumFav72 += fav72;
        if (fav24 >= 1.5) b.hit24++;
        if (fav48 >= 1.5) b.hit48++;
        if (fav72 >= 1.5) b.hit72++;
        if (fav24 >= 2.0) b.sum2_24++;
        if (fav48 >= 2.0) b.sum2_48++;
        if (fav72 >= 2.0) b.sum2_72++;

        if (hasDirCols) {
            const r24 = parseFloat(fields[idxMap.fwdReturn24H]);
            const r48 = parseFloat(fields[idxMap.fwdReturn48H]);
            const r72 = parseFloat(fields[idxMap.fwdReturn72H]);
            // Need a meaningful 24h move to anchor the comparison — sub-0.3% returns
            // are noise where the "direction" is meaningless. Same on the longer side.
            const NOISE_PCT = 0.3;
            if (Number.isFinite(r24) && Math.abs(r24) >= NOISE_PCT) {
                b.nDirAware++;
                if (Number.isFinite(r48) && Math.abs(r48) >= NOISE_PCT && Math.sign(r24) === Math.sign(r48)) b.agree48++;
                if (Number.isFinite(r72) && Math.abs(r72) >= NOISE_PCT && Math.sign(r24) === Math.sign(r72)) b.agree72++;
            }
        }

        rows++;
    }
    return { rows, sym };
}

function printTable(label: string, buckets: Map<string, BucketStats>): void {
    let total = 0, totalDirAware = 0;
    for (const b of buckets.values()) { total += b.n; totalDirAware += b.nDirAware; }
    if (total === 0) return;
    const dirEnabled = totalDirAware > 0;
    console.log(`\n=== ${label} (${total} bars${dirEnabled ? `, ${totalDirAware} direction-aware` : ''}) ===`);
    const header = ['ML bucket', 'n', 'avg fav24', 'avg fav48', 'avg fav72',
                    'hit≥1.5 24h', 'hit≥1.5 48h', 'hit≥1.5 72h',
                    'hit≥2.0 24h', 'hit≥2.0 48h', 'hit≥2.0 72h'];
    if (dirEnabled) header.push('dirAgree 48h', 'dirAgree 72h');
    console.log(header.join('\t'));
    for (const k of ORDER) {
        const b = buckets.get(k);
        if (!b || b.n === 0) continue;
        const pct = (x: number) => `${(x * 100 / b.n).toFixed(1)}%`;
        const avg = (s: number) => (s / b.n).toFixed(2);
        const row: (string | number)[] = [
            k.padEnd(8), b.n,
            avg(b.sumFav24), avg(b.sumFav48), avg(b.sumFav72),
            pct(b.hit24), pct(b.hit48), pct(b.hit72),
            pct(b.sum2_24), pct(b.sum2_48), pct(b.sum2_72),
        ];
        if (dirEnabled) {
            // Agreement is measured only over bars with a meaningful 24h move (nDirAware).
            const dpct = (x: number) => b.nDirAware > 0 ? `${(x * 100 / b.nDirAware).toFixed(1)}%` : '–';
            row.push(dpct(b.agree48), dpct(b.agree72));
        }
        console.log(row.join('\t'));
    }
}

async function main() {
    const args = parseArgs(process.argv);
    // Accept any *.csv now (was *USDT.csv when this was crypto-only).
    let files = (await readdir(args.srcDir)).filter(f => f.endsWith('.csv'));
    if (args.symbolFilter) files = files.filter(f => f.startsWith(args.symbolFilter!.toUpperCase() + '.'));
    console.log(`[persistence] scoring ${files.length} files…`);

    const cryptoBuckets = new Map<string, BucketStats>();
    const stockBuckets = new Map<string, BucketStats>();
    let totalRows = 0;
    for (const f of files) {
        const r = await processCsv(join(args.srcDir, f), cryptoBuckets, stockBuckets);
        totalRows += r.rows;
        process.stdout.write(`.`);
    }
    process.stdout.write(`\n[persistence] ${totalRows} bars scored\n`);

    printTable('CRYPTO (model: crypto v10)', cryptoBuckets);
    printTable('STOCKS (model: stock v12)', stockBuckets);
}

main().catch(e => { console.error(e); process.exit(1); });
