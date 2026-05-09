// ETH/BTC ratio historical via Binance ETHBTC klines. Used for crypto cross-asset
// features: ethBtcRatio (current ratio) and ethBtcDelta6 (6-bar % change).
//
// CRITICAL: 4H interval, not daily. Mirrors BacktestEngine.swift:277-278 which
// fetches ETH/BTC at "4h" — the "6 bars back" in ethBtcDelta6 means 24h, not 6 days.
// Daily lookback gave a ~40pp drift on the parity diff (sample 19.17 vs 0.78).

import { fetchBinanceKlines } from './candles-binance.js';
import type { Candle } from '../../src/scoring-full.js';

export async function fetchEthBtcFourH(startMs: number, endMs: number): Promise<Candle[]> {
    return fetchBinanceKlines('ETHBTC', '4h', startMs, endMs);
}

/// Find the latest ETH/BTC 4H close at or before evalMs and the 6-bar (= 24h)
/// percent change. Mirrors BacktestEngine.swift:773-779: cur = candles[idx-1].close,
/// prev = candles[idx-7].close, delta = (cur - prev) / prev * 100.
export function lookupEthBtc(candles: Candle[], evalMs: number): { ratio: number; delta6: number } {
    if (candles.length === 0) return { ratio: 0, delta6: 0 };
    let lo = 0, hi = candles.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time <= evalMs) lo = mid + 1; else hi = mid;
    }
    // Swift uses `ethBtcIdx` as "first candle with time > evalTime", then ratio = candles[idx-1]
    // and delta uses candles[idx-7]. lo here is the same as Swift's ethBtcIdx, so lo-1 = ratio idx.
    if (lo === 0) return { ratio: 0, delta6: 0 };
    const cur = candles[lo - 1].close;
    const prevIdx = lo - 7;
    const delta6 = prevIdx >= 0 && candles[prevIdx].close > 0
        ? ((cur - candles[prevIdx].close) / candles[prevIdx].close) * 100
        : 0;
    return { ratio: cur, delta6 };
}
