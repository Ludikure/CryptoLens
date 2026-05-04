/**
 * Aggregates 1H candles into 4H candles, matching iOS CandleAggregator.aggregate1HTo4H exactly.
 *
 * Groups by ET trading day (DST-aware via Intl.DateTimeFormat with America/New_York), then
 * chunks each day's candles into 4-bar blocks. The merged 4H bar uses first.open, max.high,
 * min.low, last.close, and summed volume.
 *
 * The iOS-canonical logic is in CryptoLens/Utils/CandleAggregator.swift. Any change to one
 * side must be mirrored to the other or the worker's ML predictions will diverge from the
 * app's. Parity is enforced by test/aggregation.test.ts.
 */

interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export function aggregate1HTo4H_ET<T extends Bar>(hourly: T[]): T[] {
    if (hourly.length === 0) return [];

    const dateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
    });

    const byDay: Record<string, T[]> = {};
    for (const c of hourly) {
        const etDate = dateFmt.format(new Date(c.time));
        (byDay[etDate] ||= []).push(c);
    }

    const merged: T[] = [];
    for (const day of Object.keys(byDay).sort()) {
        const session = byDay[day].sort((a, b) => a.time - b.time);
        for (let i = 0; i < session.length; i += 4) {
            const chunk = session.slice(i, i + 4);
            if (chunk.length === 0) continue;
            merged.push({
                ...chunk[0],
                time: chunk[0].time,
                open: chunk[0].open,
                high: Math.max(...chunk.map(b => b.high)),
                low: Math.min(...chunk.map(b => b.low)),
                close: chunk[chunk.length - 1].close,
                volume: chunk.reduce((s, b) => s + b.volume, 0),
            } as T);
        }
    }
    return merged;
}
