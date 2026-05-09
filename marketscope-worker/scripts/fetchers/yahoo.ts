// Yahoo Finance candle fetchers for VIX, VIX3M, DXY, and stock symbols. The chart API
// supports `range=10y` etc.; for backtests reaching pre-2015 history we use period1/
// period2 epoch-second params. Same User-Agent header the worker cron uses.
//
// Daily: unlimited history.
// 1H: Yahoo enforces "within the last 730 days" — requests with period1 older than that
//     return 422 / empty. The stock backtester combines Yahoo 1H (recent ~720d) with
//     D1 1H (anything older) to span multi-year windows without rate-limited paid APIs.

import type { Candle } from '../../src/scoring-full.js';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

async function fetchYahoo(
    symbol: string, interval: '1d' | '1h', startMs: number, endMs: number,
): Promise<Candle[]> {
    const period1 = Math.floor(startMs / 1000);
    const period2 = Math.floor(endMs / 1000);
    const url = `${BASE}/${encodeURIComponent(symbol)}?interval=${interval}&period1=${period1}&period2=${period2}&events=history`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) throw new Error(`Yahoo ${symbol} ${interval} HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp) return [];
    const ts = r.timestamp as number[];
    const q = r.indicators.quote[0];
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
        const close = q.close?.[i];
        if (!close || close <= 0) continue;
        out.push({
            time: ts[i] * 1000,
            open: q.open?.[i] ?? close,
            high: q.high?.[i] ?? close,
            low: q.low?.[i] ?? close,
            close,
            volume: q.volume?.[i] ?? 0,
        });
    }
    return out;
}

export const fetchYahooDaily = (symbol: string, startMs: number, endMs: number) =>
    fetchYahoo(symbol, '1d', startMs, endMs);

export const fetchYahoo1H = (symbol: string, startMs: number, endMs: number) =>
    fetchYahoo(symbol, '1h', startMs, endMs);

/// Look up the latest daily close at or before evalMs. Returns 0 if no data.
export function lookupClose(candles: Candle[], evalMs: number): number {
    if (candles.length === 0) return 0;
    let lo = 0, hi = candles.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time <= evalMs) lo = mid + 1; else hi = mid;
    }
    return lo === 0 ? 0 : candles[lo - 1].close;
}

/// Slice up to and including the bar at evalMs. Used to pass `dxyCandles` etc. to
/// computeAllFeatures, which internally computes EMA-20 / momentum etc. on the slice.
export function sliceUpToTime(candles: Candle[], evalMs: number): Candle[] {
    let lo = 0, hi = candles.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time <= evalMs) lo = mid + 1; else hi = mid;
    }
    return candles.slice(0, lo);
}
