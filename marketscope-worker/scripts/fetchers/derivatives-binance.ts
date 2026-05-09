// Historical derivatives fetch from Binance Futures (fapi). Direct port of Swift's
// HistoricalDerivativesService at CryptoLens/Services/HistoricalDerivativesService.swift —
// same endpoints, same pagination, same 4H-bar-aligned merge.
//
// Important caveat (matches Swift line 141): OI / long-short / taker-ratio endpoints
// have ~30-day retention on Binance. Funding rate has long history (back to 2020).
// For older bars, OI/LS/Taker fields will be missing → caller falls back to defaults.
//
// Usage from runBacktest:
//   const merged = await fetchDerivativesHistory(symbol, startMs, endMs);
//   const bar = merged.get(round4H(evalTimeMs));

const FAPI = 'https://fapi.binance.com';
const FOUR_H_MS = 14_400_000;

export interface DerivativesBar {
    timeMs: number;          // 4H boundary (ms epoch)
    fundingRate?: number;     // already × 100 to match worker's "rate as percent" convention
    openInterest?: number;
    longPercent?: number;     // 0-100
    takerBuySellRatio?: number;
}

export type DerivativesHistory = Map<number, DerivativesBar>;

export function round4H(ms: number): number {
    return Math.floor(ms / FOUR_H_MS) * FOUR_H_MS;
}

export async function fetchDerivativesHistory(
    symbol: string, startMs: number, endMs: number,
): Promise<DerivativesHistory> {
    const [funding, oi, ls, taker] = await Promise.all([
        fetchFundingHistory(symbol, startMs, endMs),
        fetchTimeSeries('/futures/data/openInterestHist', symbol, '4h', startMs, endMs, 'sumOpenInterest'),
        fetchTimeSeries('/futures/data/globalLongShortAccountRatio', symbol, '4h', startMs, endMs, 'longAccount')
            .then(rows => rows.map(([t, v]) => [t, v * 100] as [number, number])),
        fetchTimeSeries('/futures/data/takerlongshortRatio', symbol, '4h', startMs, endMs, 'buySellRatio'),
    ]);

    const merged: DerivativesHistory = new Map();
    const upsert = (timeMs: number, patch: Partial<DerivativesBar>): void => {
        const key = round4H(timeMs);
        const existing = merged.get(key) ?? { timeMs: key };
        merged.set(key, { ...existing, ...patch });
    };
    for (const [ts, fr] of funding) upsert(ts, { fundingRate: fr });
    for (const [ts, v] of oi) upsert(ts, { openInterest: v });
    for (const [ts, v] of ls) upsert(ts, { longPercent: v });
    for (const [ts, v] of taker) upsert(ts, { takerBuySellRatio: v });
    return merged;
}

/// /fapi/v1/fundingRate — 8-hourly snapshots, paginated 1000/page. Long history.
/// Matches HistoricalDerivativesService.swift:74-107. Returns rate × 100 (decimal → percent).
async function fetchFundingHistory(
    symbol: string, startMs: number, endMs: number,
): Promise<Array<[number, number]>> {
    const out: Array<[number, number]> = [];
    let cursor = startMs;
    while (cursor < endMs) {
        const url = `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
        const resp = await fetchWithRetry(url);
        if (!resp.ok) {
            // Mirror Swift's "advance and continue" behaviour on 4xx so a single bad
            // page doesn't sink the whole series.
            cursor += 1000 * 8 * 3600 * 1000;
            continue;
        }
        const rows = await resp.json() as Array<{ fundingTime: number; fundingRate: string }>;
        if (!rows.length) break;
        let lastTs = 0;
        for (const r of rows) {
            const ts = r.fundingTime;
            const rate = parseFloat(r.fundingRate);
            if (Number.isFinite(rate)) out.push([ts, rate * 100]);
            if (ts > lastTs) lastTs = ts;
        }
        cursor = lastTs + 1;
        if (rows.length < 1000) break;
        await sleep(200);
    }
    return out;
}

/// Generic 4H-period series fetcher for /futures/data endpoints. ~30-day retention.
async function fetchTimeSeries(
    endpoint: string, symbol: string, period: string,
    startMs: number, endMs: number, valueKey: string,
): Promise<Array<[number, number]>> {
    const out: Array<[number, number]> = [];
    let cursor = startMs;
    while (cursor < endMs) {
        const url = `${FAPI}${endpoint}?symbol=${symbol}&period=${period}&startTime=${cursor}&endTime=${endMs}&limit=500`;
        const resp = await fetchWithRetry(url);
        if (!resp.ok) {
            cursor += 500 * 4 * 3600 * 1000;
            continue;
        }
        const rows = await resp.json() as Array<Record<string, any>>;
        if (!rows.length) break;
        let lastTs = 0;
        for (const r of rows) {
            const ts = typeof r.timestamp === 'number' ? r.timestamp : parseInt(r.timestamp, 10);
            if (!Number.isFinite(ts)) continue;
            const raw = r[valueKey];
            const v = typeof raw === 'number' ? raw : parseFloat(raw);
            if (Number.isFinite(v)) out.push([ts, v]);
            if (ts > lastTs) lastTs = ts;
        }
        cursor = lastTs + 1;
        if (rows.length < 500) break;
        await sleep(200);
    }
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/// Fetch with retry on transport failures (Node `TypeError: fetch failed`) and
/// rate-limit responses (429/418/5xx). Mirrors candles-binance.ts's pattern;
/// returns the Response so the caller can branch on resp.ok for non-retryable
/// 4xx (e.g. 400 from Binance for a delisted/invalid symbol — those propagate
/// up and the caller's existing "advance cursor on 4xx" logic handles them).
async function fetchWithRetry(url: string, maxRetries = 5): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetch(url);
            if (resp.status === 429 || resp.status === 418 || resp.status >= 500) {
                const ra = parseInt(resp.headers.get('Retry-After') ?? '', 10);
                const wait = Number.isFinite(ra)
                    ? ra * 1000
                    : 1500 * (2 ** attempt) + Math.floor(Math.random() * 500);
                await sleep(wait);
                continue;
            }
            return resp;
        } catch (e) {
            lastErr = e;
            const isTransport = e instanceof TypeError
                || /fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(String(e));
            if (!isTransport) throw e;
            await sleep(1500 * (2 ** attempt) + Math.floor(Math.random() * 500));
        }
    }
    throw new Error(`Binance fapi exhausted retries: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}
