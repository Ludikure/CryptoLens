// Binance Vision (data.binance.vision) fetchers — the public S3 data dumps.
//
// WHY THIS EXISTS: api.binance.com / fapi.binance.com are HTTP-451 geoblocked from the
// dev Mac (US residential IP), which kills the direct fetchers (candles-binance.ts,
// derivatives-binance.ts) that earlier regens relied on. Binance Vision is NOT geoblocked
// (public S3/CDN) and carries FULL history:
//   - spot monthly/daily klines (candles)           → replaces api.binance.com klines
//   - futures um monthly fundingRate (2020+)        → funding, forward-filled to the 4h grid
//   - futures um monthly premiumIndexKlines 4h      → basisPct history (2020-03+)
//   - futures um daily metrics (2021-12-01+)        → OI / taker ratio / global long% history
//
// Coverage upgrade this enables (vs the fapi-era regen): funding ~50%→~100% (the old merge
// only wrote 8h funding events to every OTHER 4h bucket — live serving always has current
// funding, so forward-filling also FIXES a train/serve inconsistency), basis 0%→~100%,
// OI/taker/long% ~2%→(2021-12+). The D1 archive still overlays on top (higher fidelity).
//
// All zips are cached on disk (VISION_CACHE, gitignored) — reruns are download-free.
// Timestamp gotcha: 2025+ Vision files use MICROSECOND timestamps (was ms) — normalize.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Candle } from '../../src/scoring-full.js';
import { round4H } from './derivatives-binance.js';
import type { MergedDerivativesHistory } from '../derivatives.js';

const BASE = 'https://data.binance.vision/data';
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ml-training/vision_cache');
const FOUR_H_MS = 14_400_000;
const DAY_MS = 86_400_000;

// ---------- download + cache + unzip ----------

/// Download a Vision zip to the cache (atomic). Returns the cached path, or null on 404
/// (symbol/month not listed — normal for pre-listing dates). A 404 is cached as an empty
/// marker file so reruns don't re-request it. Retries transport errors.
async function cached(url: string): Promise<string | null> {
    const rel = url.slice(BASE.length + 1).replace(/\//g, '__');
    const dest = join(CACHE, rel);
    const miss = dest + '.404';
    if (existsSync(dest)) return dest;
    if (existsSync(miss)) return null;
    mkdirSync(dirname(dest), { recursive: true });
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 404) { await writeFile(miss, ''); return null; }
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const tmp = dest + '.tmp';
            await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
            const { rename } = await import('node:fs/promises');
            await rename(tmp, dest);
            return dest;
        } catch (e) {
            if (attempt >= 4) throw new Error(`vision: ${url}: ${e instanceof Error ? e.message : e}`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
}

/// `unzip -p` the single CSV inside a Vision zip → text.
function unzipText(zipPath: string): Promise<string> {
    return new Promise((res, rej) => {
        const p = spawn('unzip', ['-p', zipPath]);
        const chunks: Buffer[] = [];
        p.stdout.on('data', c => chunks.push(c));
        p.on('error', rej);
        p.on('close', code => code === 0 ? res(Buffer.concat(chunks).toString('utf8'))
                                         : rej(new Error(`unzip exit ${code}: ${zipPath}`)));
    });
}

/// Parse CSV text → rows of string fields, skipping header lines (first field non-numeric).
function csvRows(text: string): string[][] {
    const out: string[][] = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        const c = line.split(',');
        if (!/^\d/.test(c[0])) continue;
        out.push(c);
    }
    return out;
}

/// Normalize a Vision timestamp to ms. Handles metrics' datetime strings
/// ("2026-01-05 00:05:00" — parseInt would silently yield 2026!) and the 2025+
/// microsecond epoch switch.
function toMs(raw: string): number {
    let t: number;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) t = Date.parse(raw.replace(' ', 'T') + 'Z');
    else t = parseInt(raw, 10);
    if (t > 1e14) t = Math.floor(t / 1000);
    return t;
}

function* months(startMs: number, endMs: number): Generator<string> {
    const d = new Date(startMs);
    d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() < endMs) {
        yield `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        d.setUTCMonth(d.getUTCMonth() + 1);
    }
}

function* days(startMs: number, endMs: number): Generator<string> {
    const d = new Date(startMs);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() < endMs) {
        yield d.toISOString().slice(0, 10);
        d.setUTCDate(d.getUTCDate() + 1);
    }
}

/// Bounded-concurrency map (avoid hammering S3 with 1,600 parallel requests).
async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

// ---------- candles (spot klines) ----------

/// Spot klines from Vision monthly dumps, with daily-dump stitching for any recent month
/// whose monthly zip isn't published yet. Same Candle shape as fetchBinanceKlines.
export async function visionKlines(
    symbol: string, interval: '1d' | '4h' | '1h', startMs: number, endMs: number,
): Promise<Candle[]> {
    const out: Candle[] = [];
    const parse = (text: string) => {
        for (const c of csvRows(text)) {
            const time = toMs(c[0]);
            if (time < startMs || time >= endMs) continue;
            out.push({ time, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
        }
    };
    const monthList = [...months(startMs, endMs)];
    const paths = await pmap(monthList, 6, m =>
        cached(`${BASE}/spot/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${m}.zip`));
    for (let i = 0; i < monthList.length; i++) {
        if (paths[i]) { parse(await unzipText(paths[i]!)); continue; }
        // Monthly zip missing: for the trailing ~45 days it may simply not be published yet —
        // stitch that month from daily dumps. Older 404s = symbol not listed; skip.
        const monthStart = Date.parse(`${monthList[i]}-01T00:00:00Z`);
        if (Date.now() - monthStart > 75 * DAY_MS) continue;
        const dEnd = Math.min(endMs, Date.now());
        const dayList = [...days(Math.max(monthStart, startMs), dEnd)]
            .filter(d => d.startsWith(monthList[i]));
        const dPaths = await pmap(dayList, 6, d =>
            cached(`${BASE}/spot/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${d}.zip`));
        for (const p of dPaths) if (p) parse(await unzipText(p));
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

// ---------- derivatives (futures um) ----------

/// Full-history derivatives from Vision: funding (ffilled to the 4h grid), basisPct from
/// premium-index klines, OI/taker/long% from daily metrics (2021-12+). Returns the same
/// MergedDerivativesHistory shape scripts/derivatives.ts merges D1 on top of.
export async function visionDerivHistory(
    symbol: string, startMs: number, endMs: number,
): Promise<MergedDerivativesHistory> {
    const hist: MergedDerivativesHistory = new Map();
    const at = (key: number) => {
        let b = hist.get(key);
        if (!b) { b = {}; hist.set(key, b); }
        return b;
    };
    const monthList = [...months(startMs, endMs)];

    // 1. Funding events (8h) → forward-fill to every 4h bucket (rate persists between
    //    events; live serving always has the current rate, so ffill matches serving).
    {
        const paths = await pmap(monthList, 6, m =>
            cached(`${BASE}/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${m}.zip`));
        const events: Array<[number, number]> = [];
        for (const p of paths) {
            if (!p) continue;
            for (const c of csvRows(await unzipText(p))) {
                // columns: calc_time, funding_interval_hours, last_funding_rate (order stable)
                events.push([toMs(c[0]), parseFloat(c[c.length - 1]) * 100]);
            }
        }
        events.sort((a, b) => a[0] - b[0]);
        if (events.length) {
            let ei = 0;
            let rate: number | undefined;
            for (let t = round4H(Math.max(startMs, events[0][0])); t < endMs; t += FOUR_H_MS) {
                while (ei < events.length && events[ei][0] <= t + FOUR_H_MS - 1) rate = events[ei++][1];
                if (rate !== undefined) at(t).fundingRate = rate;
            }
        }
    }

    // 2. Basis: premium-index 4h klines, OPEN value at the bucket boundary (no lookahead).
    {
        const paths = await pmap(monthList, 6, m =>
            cached(`${BASE}/futures/um/monthly/premiumIndexKlines/${symbol}/4h/${symbol}-4h-${m}.zip`));
        for (const p of paths) {
            if (!p) continue;
            for (const c of csvRows(await unzipText(p))) {
                const t = round4H(toMs(c[0]));
                if (t < startMs || t >= endMs) continue;
                at(t).basisPct = parseFloat(c[1]) * 100;  // open, premium fraction → percent
            }
        }
    }

    // 3. Metrics (daily files, 5-min rows, from 2021-12-01): last row per 4h bucket →
    //    OI + taker buy/sell ratio + global long% (accounts ratio r → 100·r/(1+r)).
    {
        const METRICS_EPOCH = Date.parse('2021-12-01T00:00:00Z');
        const dayList = [...days(Math.max(startMs, METRICS_EPOCH), Math.min(endMs, Date.now()))];
        const paths = await pmap(dayList, 8, d =>
            cached(`${BASE}/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${d}.zip`));
        for (const p of paths) {
            if (!p) continue;
            for (const c of csvRows(await unzipText(p))) {
                // create_time,symbol,sum_open_interest,sum_open_interest_value,
                // count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,
                // count_long_short_ratio,sum_taker_long_short_vol_ratio
                const t = round4H(toMs(c[0]));
                if (t < startMs || t >= endMs) continue;
                const b = at(t);                     // rows are chronological → last wins
                const oi = parseFloat(c[2]);
                if (Number.isFinite(oi)) b.openInterest = oi;
                const lsr = parseFloat(c[6]);
                if (Number.isFinite(lsr) && lsr > 0) b.longPercent = (lsr / (1 + lsr)) * 100;
                const taker = parseFloat(c[7]);
                if (Number.isFinite(taker) && taker > 0) b.takerRatio = taker;
            }
        }
    }

    return hist;
}
