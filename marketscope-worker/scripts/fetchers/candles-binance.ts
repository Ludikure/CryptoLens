// Paginated Binance kline fetch. Klines API caps at 1000 candles per call; for multi-year
// histories we walk forward by `startTime` until we either hit the requested end or get a
// short page. Public endpoint — no auth, ~6000 weight/min rate limit per IP (klines weight=1
// at limit≤100, weight=2 at limit≤1000, so we're at 2/req here).
//
// At concurrency 8 with 4 parallel fetchers per symbol (1d, 4h, 1h, deriv), the burst can
// hit ~32 simultaneous requests. Binance starts returning 429s + dropping connections
// (presents as Node `fetch failed` TypeError, not an HTTP error) around 20-25 RPS.
// The retry wrapper below handles both response-level (429/418/5xx) and transport-level
// (TypeError) failures with capped exponential backoff.

import type { Candle } from '../../src/scoring-full.js';

const BASE = 'https://api.binance.com/api/v3';

type Interval = '1d' | '4h' | '1h';

const INTERVAL_MS: Record<Interval, number> = {
    '1d': 86_400_000,
    '4h': 14_400_000,
    '1h': 3_600_000,
};

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1500;

/// Fetch with retry on rate-limit / connection failure. Returns the parsed JSON array of
/// klines. Caller handles short-page detection (< 1000 = end of history).
async function fetchKlinesPage(url: string, label: string): Promise<any[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url);
            if (resp.status === 429 || resp.status === 418 || resp.status >= 500) {
                // 429 = rate limit, 418 = banned (escalation of 429), 5xx = transient.
                // Honor Retry-After when present, else exponential backoff with jitter.
                const ra = parseInt(resp.headers.get('Retry-After') ?? '', 10);
                const wait = Number.isFinite(ra)
                    ? ra * 1000
                    : BASE_BACKOFF_MS * (2 ** attempt) + Math.floor(Math.random() * 500);
                await sleep(wait);
                continue;
            }
            if (!resp.ok) {
                // 4xx other than rate limit — don't retry, e.g. 400 for delisted symbol.
                throw new Error(`${label} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
            }
            const rows = await resp.json();
            if (!Array.isArray(rows)) throw new Error(`${label}: non-array response`);
            return rows;
        } catch (e) {
            lastErr = e;
            // TypeError "fetch failed" (TCP/DNS/TLS) — retry. Plus our explicit non-array
            // throw above. JSON.parse errors also flow here.
            const isTransport = e instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(String(e));
            if (!isTransport && attempt > 0) throw e;
            const wait = BASE_BACKOFF_MS * (2 ** attempt) + Math.floor(Math.random() * 500);
            await sleep(wait);
        }
    }
    throw new Error(`${label}: exhausted ${MAX_RETRIES} retries (last: ${lastErr instanceof Error ? lastErr.message : lastErr})`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Fetch all klines for `symbol` between `startMs` and `endMs` at the given interval.
 * Pagination is by `startTime`; each call returns up to 1000 candles. Stops when the
 * server returns a partial page (last page) or we've crossed the end timestamp.
 *
 * Returns candles in the worker's `Candle` format (matches scoring-full.ts).
 */
export async function fetchBinanceKlines(
    symbol: string,
    interval: Interval,
    startMs: number,
    endMs: number,
): Promise<Candle[]> {
    const out: Candle[] = [];
    let cursor = startMs;
    const label = `Binance ${symbol} ${interval}`;
    while (cursor < endMs) {
        const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
        const rows = await fetchKlinesPage(url, label);
        if (rows.length === 0) break;
        for (const r of rows) {
            const time = r[0] as number;
            if (time >= endMs) break;
            out.push({
                time,
                open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
            });
        }
        // Advance cursor past last candle's open time. If page is short, server has nothing
        // more — bail. Otherwise, jump to the next interval boundary.
        const lastTime = rows[rows.length - 1][0] as number;
        if (rows.length < 1000) break;
        cursor = lastTime + INTERVAL_MS[interval];
    }
    // Drop the in-progress (latest) candle to match BacktestEngine semantics. The last
    // candle whose close is in the future shouldn't be evaluated.
    return dropInProgress(out, interval);
}

function dropInProgress(candles: Candle[], interval: Interval): Candle[] {
    if (candles.length === 0) return candles;
    const last = candles[candles.length - 1];
    if (last.time + INTERVAL_MS[interval] > Date.now()) {
        return candles.slice(0, -1);
    }
    return candles;
}
