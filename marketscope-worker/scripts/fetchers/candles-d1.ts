// Per-symbol candle fetcher backed by D1 `candles` archive. BacktestEngine.swift
// uploads full historical candle sets there during its own backtest runs (see
// `archiveCandlesToD1` calls) — so any symbol previously processed by the iOS
// backtester has multi-year coverage at all three intervals (1d, 4h, 1h).
//
// We invoke `wrangler d1 execute --remote` per (symbol, interval) request. Single-
// symbol queries are cheap (~30ms for ~13K rows) so we don't bother with a global
// dump like derivatives-d1.ts does — the candles table has ~16M rows total which
// would be wasteful to load in-memory if a run only touches a handful of symbols.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Candle } from '../../src/scoring-full.js';

const execFileP = promisify(execFile);

type Interval = '1d' | '4h' | '1h';

/**
 * Pulls all D1-archived candles for `symbol` at `interval` within [startMs, endMs].
 * Returns sorted ascending by `time` (ms). Empty array if D1 is unreachable or has
 * no rows — caller decides whether to fall back to Yahoo / treat as fatal.
 */
export async function fetchD1Candles(
    symbol: string, interval: Interval, startMs: number, endMs: number,
): Promise<Candle[]> {
    const sql = `SELECT timestamp, open, high, low, close, volume
                 FROM candles
                 WHERE symbol = '${symbol.replace(/'/g, "''")}'
                   AND interval = '${interval}'
                   AND timestamp >= ${startMs} AND timestamp < ${endMs}
                 ORDER BY timestamp ASC`;
    let stdout: string;
    try {
        const r = await execFileP('npx', [
            'wrangler', 'd1', 'execute', 'marketscope-db', '--remote',
            '--json', '--command', sql,
        ], { maxBuffer: 256 * 1024 * 1024 });
        stdout = r.stdout;
    } catch (e) {
        throw new Error(`D1 ${symbol} ${interval}: ${e instanceof Error ? e.message : e}`);
    }
    const parsed = JSON.parse(stdout);
    const rows: any[] = parsed?.[0]?.results ?? [];
    return rows.map(r => ({
        time: r.timestamp as number,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume ?? 0,
    }));
}
