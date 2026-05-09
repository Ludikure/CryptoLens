// Loads the bundled FINRA dark-pool history JSON (CryptoLens/Resources/) and exposes
// per-symbol per-day lookups. The file ships in the iOS bundle but the worker doesn't
// import it — historical backtests need it, live cron uses KV-cached daily values.
//
// Format (per `finra_dark_pool.py` output):
//   { "AAPL": [{ "date": "2020-01-02", "ratio": 0.563, "zscore": 0.0 }, ...], ... }

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface DarkPoolDay {
    date: string;     // YYYY-MM-DD
    timeMs: number;   // pre-parsed for lookup
    ratio: number;
    zscore: number;
}

export type DarkPoolSeries = Map<string, DarkPoolDay[]>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(HERE, '../../../CryptoLens/Resources/dark_pool_history.json');

/// Load + parse the JSON once. Caller passes the result into `lookupDarkPool` per bar.
export async function loadDarkPoolHistory(path: string = DEFAULT_PATH): Promise<DarkPoolSeries> {
    const text = await readFile(path, 'utf8');
    const raw = JSON.parse(text) as Record<string, { date: string; ratio: number; zscore: number }[]>;
    const out: DarkPoolSeries = new Map();
    for (const [sym, days] of Object.entries(raw)) {
        const parsed: DarkPoolDay[] = days.map(d => ({
            date: d.date,
            timeMs: Date.parse(d.date + 'T00:00:00Z'),
            ratio: d.ratio,
            zscore: d.zscore,
        }));
        // Source is already sorted but sort defensively in case future exports change.
        parsed.sort((a, b) => a.timeMs - b.timeMs);
        out.set(sym, parsed);
    }
    return out;
}

/// Latest-value-at-or-before lookup. Mirrors live cron behaviour — the dark-pool ratio
/// reflects the most recent FINRA daily file, so we use the bar's calendar day if
/// present and fall back to the prior trading day otherwise. Returns the iOS default
/// (`{ratio: 0.5, zscore: 0}`) when no entry exists, matching `darkPool ?? defaults`
/// in scoring-full.ts:1115-1116.
export function lookupDarkPool(
    series: DarkPoolSeries, symbol: string, evalMs: number,
): { ratio: number; zscore: number } {
    const days = series.get(symbol);
    if (!days || days.length === 0) return { ratio: 0.5, zscore: 0 };
    let lo = 0, hi = days.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (days[mid].timeMs <= evalMs) lo = mid + 1; else hi = mid;
    }
    if (lo === 0) return { ratio: 0.5, zscore: 0 };
    const d = days[lo - 1];
    return { ratio: d.ratio, zscore: d.zscore };
}
