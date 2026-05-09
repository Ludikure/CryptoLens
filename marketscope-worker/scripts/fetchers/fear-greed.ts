// Fear & Greed historical fetch via alternative.me. Free, no auth, single call returns
// all history (one row per day) since Feb 2018.
//
// CRITICAL: lookup is bucketed by **America/New_York** day boundary, not UTC. Swift's
// FearGreedService stores entries keyed by `Calendar.current.startOfDay(for: ts)` and
// looks them up the same way (BacktestEngine.swift:769). The user's macOS / iOS local
// TZ is ET, so Swift effectively buckets by ET day. Bucketing by raw UTC midnight (the
// previous Node implementation) caused 1-day offsets that drifted the index by up to
// ~37 points in the parity diff.

export interface FearGreedPoint {
    /// ET-day key as `YYYY-MM-DD` string. Lookup converts evalMs to the same key.
    etDay: string;
    index: number;
    zone: number;
}

const URL = 'https://api.alternative.me/fng/?limit=0';

function etDayKey(ms: number): string {
    // en-CA en-US locales emit ISO-like `YYYY-MM-DD` from the date-only formatter.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
}

export async function fetchFearGreedHistory(): Promise<FearGreedPoint[]> {
    const resp = await fetch(URL);
    if (!resp.ok) throw new Error(`Fear & Greed HTTP ${resp.status}`);
    const j = await resp.json() as any;
    const rows = (j?.data ?? []) as Array<{ value: string; timestamp: string }>;
    const points: FearGreedPoint[] = rows
        .map(r => {
            const value = parseInt(r.value, 10);
            const tsMs = parseInt(r.timestamp, 10) * 1000;
            return {
                etDay: etDayKey(tsMs),
                index: value,
                zone: value <= 20 ? -2 : value <= 40 ? -1 : value <= 60 ? 0 : value <= 80 ? 1 : 2,
            };
        })
        .filter(p => p.etDay && Number.isFinite(p.index))
        .sort((a, b) => a.etDay.localeCompare(b.etDay));
    return points;
}

/// Look up the F&G value for a given evaluation timestamp by ET-day key. Returns
/// the most recent point with `etDay <= evalDay`. Falls back to neutral (50, 0) if
/// no history is available.
export function lookupFearGreed(history: FearGreedPoint[], evalMs: number): { index: number; zone: number } {
    if (history.length === 0) return { index: 50, zone: 0 };
    const evalDay = etDayKey(evalMs);
    let lo = 0, hi = history.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (history[mid].etDay <= evalDay) lo = mid + 1; else hi = mid;
    }
    if (lo === 0) return { index: 50, zone: 0 };
    const p = history[lo - 1];
    return { index: p.index, zone: p.zone };
}
