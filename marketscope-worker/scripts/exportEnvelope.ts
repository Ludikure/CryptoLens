// Export the Conviction Envelope's per-bar verdict, so gate research reads what production
// decides instead of a Python reconstruction of it.
//
// WHY. Every envelope measurement before this one rebuilt the rules in Python, and every one of the
// five measurement defects the 2026-08-25 reviews found was a reconstruction defect: a sign flipped
// (`funding_supports_counter` was reconstructed as the exact logical complement of the live rule),
// a proxy whose domain made a threshold trivially true (`|momentumAlignment| < 2` fires on 100% of
// rows), a population an order of magnitude too large (both kill rows, because `ANY_KILLED` only
// exists on counter-trend-pullback bars). None of those are careless — they are what happens when
// the thing being measured and the thing being run are two different pieces of code.
//
// This calls `buildUserPrompt`, the real builder, and records `result.envelope` — the verdict
// object itself, not a parse of the rendered text. That distinction matters: three of the four
// lists are printed only on non-FLAT bars, so a text parse is blind on 66 of 66 FLAT bars measured.
//
// JOIN CONTRACT. Rows are keyed `(symbol, timestamp)` against `ml-training/csv_exports_v14/<SYM>.csv`
// and the script REFUSES TO WRITE unless, over the overlapping range, both the timestamp series and
// the price series match that file. Timestamps alone would not catch a slice that is off by one
// bar; price is what pins the alignment.
//
// CANDLES come from the local box snapshot `marketscope.db`, not the network: reproducible, offline,
// and free of the rate-limit cascade that makes a full regen a multi-hour affair. The snapshot ends
// before v14 does, so the join is asserted over the overlap and the shortfall is reported.
//
// Usage:
//   npx tsx scripts/exportEnvelope.ts BTCUSDT [--out DIR] [--ml FILE.csv] [--limit N]
//   npx tsx scripts/exportEnvelope.ts --all [--out DIR]

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeFullIndicators } from '../src/indicators-full.js';
import { buildUserPrompt, type PromptIndicator, type PromptState } from '../src/prompt.js';
import type { EnvelopeInput, EnvelopeVerdict } from '../src/envelope.js';

const DB_PATH = 'marketscope.db';
const V14_DIR = '../ml-training/csv_exports_v14';

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

function loadCandles(db: Database.Database, symbol: string, interval: string): Bar[] {
    return db.prepare(
        `SELECT timestamp AS time, open, high, low, close, volume FROM candles
         WHERE symbol = ? AND interval = ? ORDER BY timestamp ASC`).all(symbol, interval) as Bar[];
}

/**
 * Count of candles at or before `t` — `runBacktest.sliceUpTo(...).length`, without materialising the
 * prefix. The original returns the whole history and the caller keeps its last 300; doing that per
 * bar is quadratic, and on a symbol with 77k hourly bars it is the difference between 30 seconds and
 * never finishing. Returning the index keeps the slice semantics identical.
 */
function countUpTo(candles: Bar[], t: number): number {
    let lo = 0, hi = candles.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time <= t) lo = mid + 1; else hi = mid; }
    return lo;
}

/**
 * The v14 columns used to prove this run's SLICES match the ones that produced the training rows.
 * Price alone is not enough — it is read off the bar, so it agrees even when the indicator windows
 * are off by one (verified: an `i-300..i` mutation passed a price-only check). `dRsi` comes from the
 * daily slice, `hRsi` from the 4H slice and `atrPercentile` from the daily population, so a shift in
 * any window moves at least one of them.
 */
const V14_COL = { ts: 1, price: 2, atrPercentile: 13, dRsi: 14, hRsi: 33 } as const;

export interface V14Row { ts: number; price: number; atrPercentile: number; dRsi: number; hRsi: number; }
function loadV14(symbol: string): V14Row[] | null {
    const p = join(V14_DIR, `${symbol}.csv`);
    if (!existsSync(p)) return null;
    const lines = readFileSync(p, 'utf-8').trim().split('\n');
    return lines.slice(1).map(l => {
        const c = l.split(',');
        return {
            ts: Number(c[V14_COL.ts]), price: Number(c[V14_COL.price]),
            atrPercentile: Number(c[V14_COL.atrPercentile]),
            dRsi: Number(c[V14_COL.dRsi]), hRsi: Number(c[V14_COL.hRsi]),
        };
    });
}

/** Optional walk-forward OOF ML predictions: `symbol,timestamp,ml` (timestamp in SECONDS). */
function loadML(path: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const line of readFileSync(path, 'utf-8').trim().split('\n').slice(1)) {
        const [sym, ts, ml] = line.split(',');
        m.set(`${sym}:${ts}`, Number(ml));
    }
    return m;
}

const FIELDS = [
    'staleCount', 'anyKilled', 'macroRisk', 'newsConflicts', 'alignment', 'alignedDirection',
    'continuationCount', 'isCrypto', 'isStock', 'regime', 'longConfirmStatus', 'oneHOpposes',
    'cryptoBearRegime', 'daysToEarnings',
] as const;

// `dRsi` / `hRsi` / `atrPct` are join-verification columns, not research inputs: they exist so the
// file carries the evidence that its slices matched v14's, rather than only having been checked once.
const HEADER = ['symbol', 'timestamp', 'price', 'rawMlPct', 'mlPct', 'maxAllowed',
    'autoFlat', 'highBlocks', 'moderateBlocks', 'downgrade', ...FIELDS,
    'dRsi', 'hRsi', 'atrPct'].join(',');

const num = (v: number | null | undefined) => (v == null ? '' : v.toFixed(4));

export interface ExportResult { symbol: string; rows: number; skipped: number; csv: string; }

export function exportEnvelope(db: Database.Database, symbol: string, opts: {
    ml?: Map<string, number>; limit?: number;
} = {}): ExportResult {
    const isCrypto = symbol.toUpperCase().endsWith('USDT');
    const dailyAll = loadCandles(db, symbol, '1d');
    const fourHAll = loadCandles(db, symbol, '4h');
    const oneHAll = loadCandles(db, symbol, '1h');
    if (!fourHAll.length) throw new Error(`${symbol}: no 4h candles in ${DB_PATH}`);

    // The eval window must start where v14's did or the series cannot join. Rather than re-deriving
    // it from the same clamp rules `runBacktest` applies (crypto pinned to Jan 2020 for derivatives
    // coverage, stocks to their archive start), read it off the file being joined to — the
    // authority on where v14 actually began is v14. The `>= 210` floor is runBacktest.ts:399.
    const v14Rows = loadV14(symbol);
    if (!v14Rows?.length) throw new Error(`${symbol}: no csv_exports_v14/${symbol}.csv to align to`);
    const startMs = v14Rows[0].ts * 1000;
    let evalStartIndex = fourHAll.findIndex(c => c.time >= startMs);
    if (evalStartIndex < 210) evalStartIndex = 210;
    if (evalStartIndex >= fourHAll.length) throw new Error(`${symbol}: only ${fourHAll.length} 4h bars`);

    const out: string[] = [HEADER];
    let state: PromptState = {};
    let skipped = 0;
    const end = opts.limit ? Math.min(fourHAll.length - 1, evalStartIndex + opts.limit) : fourHAll.length - 1;

    for (let i = evalStartIndex; i < end; i++) {
        const evalTime = fourHAll[i].time;
        // The slice rules are runBacktest.ts:416-420 verbatim, including the leak fix: the
        // in-progress DAY is dropped, because at an intraday 4H bar the current daily candle
        // contains the bars after this one.
        const dEnd = countUpTo(dailyAll, evalTime - 86_400_000);
        const dailySlice = dailyAll.slice(Math.max(0, dEnd - 300), dEnd);
        const fourHSlice = fourHAll.slice(Math.max(0, i + 1 - 300), i + 1);
        const hEnd = countUpTo(oneHAll, evalTime);
        const oneHSlice = oneHAll.slice(Math.max(0, hEnd - 300), hEnd);
        if (dailySlice.length < 250 || fourHSlice.length < 210) { skipped++; continue; }

        const indicators: PromptIndicator[] = [
            computeFullIndicators(dailySlice, { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator,
            computeFullIndicators(fourHSlice, { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator,
            computeFullIndicators(oneHSlice, { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator,
        ];
        const tsSec = Math.floor(evalTime / 1000);
        const ml = opts.ml?.get(`${symbol}:${tsSec}`);
        if (ml != null) (indicators[0] as unknown as { mlWinProbability: number }).mlWinProbability = ml;

        const r = buildUserPrompt({
            symbol, nowMs: evalTime + 14_400_000, indicators, prevState: state,
            economicEvents: [], calibratedMlWin: ml ?? null,
        } as never);
        state = r.newState;
        const v = r.envelope as EnvelopeVerdict | null;
        const inp = r.envelopeInput as EnvelopeInput | null;
        if (!v || !inp) throw new Error(`${symbol} @${tsSec}: buildUserPrompt returned no envelope`);

        out.push([
            symbol, tsSec, fourHAll[i].close.toFixed(4),
            v.rawMlPct ?? '', v.mlPct ?? '', v.maxAllowed,
            v.autoFlat.join('|'), v.highBlocks.join('|'), v.moderateBlocks.join('|'), v.downgrade.join('|'),
            ...FIELDS.map(f => {
                const x = inp[f];
                return typeof x === 'boolean' ? (x ? 1 : 0) : x == null ? '' : String(x);
            }),
            num(indicators[0].rsi), num(indicators[1].rsi), num((indicators[0] as unknown as { atrPercentile?: number }).atrPercentile),
        ].join(','));
    }
    return { symbol, rows: out.length - 1, skipped, csv: out.join('\n') + '\n' };
}

/**
 * The join gate. Refuses the export unless, over the overlapping range, this run's bars line up
 * with `csv_exports_v14` on BOTH timestamp and price. Timestamps alone would pass a slice that is
 * off by one bar; the price series is what pins the alignment.
 */
export interface JoinReport {
    matched: number;        // rows that agreed with v14 on every checked column, from the start
    total: number;          // rows this run produced
    v14Rows: number;        // rows v14 has for this symbol
    firstBadTs: number | null;
    reason: string | null;
}

/**
 * Compare an export against `csv_exports_v14` and return the length of the longest agreeing PREFIX.
 *
 * Prefix rather than all-or-nothing because of a real property of the local archive: the box's D1
 * snapshot contains mid-bar cron writes near its recent end. Measured on ADAUSDT, the 4H bar at
 * 2026-04-14 00:00 is stored with close 0.2461 on 5.9M volume where the settled bar closed 0.2447 —
 * and that settled close then appears as the OPEN of the following bar. So the archive is faithful
 * for years and then quietly stops being, at a date that differs per symbol.
 *
 * Failing the whole symbol would throw away five clean years to avoid two dirty months; accepting it
 * silently would put partial candles into a gate study. Reporting where it goes bad, truncating
 * there, and recording the date is the only honest third option.
 */
export function joinToV14(symbol: string, csv: string, rows?: V14Row[]): JoinReport {
    const v14 = rows ?? loadV14(symbol);
    if (!v14) throw new Error(`${symbol}: no csv_exports_v14/${symbol}.csv to join against`);
    const head = csv.trim().split('\n')[0].split(',');
    const ix = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`missing column ${n}`); return i; };
    const [cTs, cPx, cDRsi, cHRsi, cAtr] = ['timestamp', 'price', 'dRsi', 'hRsi', 'atrPct'].map(ix);
    const mine = csv.trim().split('\n').slice(1).map(l => l.split(','));
    if (!mine.length) throw new Error(
        `${symbol}: exported 0 rows. Every bar hit the warm-up guard (daily < 250 or 4H < 210), which `
        + `means the eval window starts before the local archive has enough history.`);

    const byTs = new Map(v14.map(r => [r.ts, r]));
    // v14 rounds the indicator columns to 1 dp, so the comparison is at that resolution. It is still
    // a sharp test: a one-bar slice shift moves 4H RSI by whole points, not hundredths.
    const TOL = 0.051;
    for (let k = 0; k < mine.length; k++) {
        const row = mine[k];
        const ts = Number(row[cTs]);
        const r = byTs.get(ts);
        const bad = (reason: string): JoinReport =>
            ({ matched: k, total: mine.length, v14Rows: v14.length, firstBadTs: ts, reason });
        if (!r) return bad('bar absent from csv_exports_v14 (eval window or warm-up guard differs)');
        const rel = Math.abs(r.price - Number(row[cPx])) / Math.max(1e-12, Math.abs(r.price));
        if (rel > 1e-6) return bad(`price ${r.price} vs ${row[cPx]} (rel ${rel.toExponential(2)}) — local candle archive disagrees`);
        for (const [name, mineV, v14V] of [
            ['dRsi', Number(row[cDRsi]), r.dRsi],
            ['hRsi', Number(row[cHRsi]), r.hRsi],
            ['atrPercentile', Number(row[cAtr]), r.atrPercentile],
        ] as Array<[string, number, number]>) {
            if (!Number.isFinite(mineV) || !Number.isFinite(v14V)) continue;
            if (Math.abs(mineV - v14V) > TOL) return bad(`${name} ${v14V} vs ${mineV.toFixed(4)} — indicator window differs`);
        }
    }
    return { matched: mine.length, total: mine.length, v14Rows: v14.length, firstBadTs: null, reason: null };
}

/** Strict form: the whole export must agree. Used by tests and by anything that cannot truncate. */
export function assertJoinsV14(symbol: string, csv: string, rows?: V14Row[]): { matched: number; v14Only: number } {
    const j = joinToV14(symbol, csv, rows);
    if (j.reason) throw new Error(`${symbol}: join failed at ${j.firstBadTs} after ${j.matched} rows — ${j.reason}`);
    return { matched: j.matched, v14Only: j.v14Rows - j.matched };
}

/** Keep only the agreeing prefix. */
export function truncateTo(csv: string, rows: number): string {
    const lines = csv.trim().split('\n');
    return [lines[0], ...lines.slice(1, rows + 1)].join('\n') + '\n';
}

function main() {
    const argv = process.argv.slice(2);
    const flag = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
    const outDir = flag('--out') ?? '../ml-training/envelope_exports';
    const mlPath = flag('--ml');
    const limit = flag('--limit') ? Number(flag('--limit')) : undefined;
    const db = new Database(DB_PATH, { readonly: true });
    const ml = mlPath ? loadML(mlPath) : undefined;

    let symbols = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out'
        && argv[argv.indexOf(a) - 1] !== '--ml' && argv[argv.indexOf(a) - 1] !== '--limit');
    if (argv.includes('--all')) {
        symbols = (db.prepare(`SELECT DISTINCT symbol FROM candles WHERE interval='4h' ORDER BY symbol`)
            .all() as Array<{ symbol: string }>).map(r => r.symbol)
            .filter(s => existsSync(join(V14_DIR, `${s}.csv`)));
    }
    if (!symbols.length) { console.error('usage: exportEnvelope.ts <SYMBOL...> | --all'); process.exit(1); }

    mkdirSync(outDir, { recursive: true });
    // A symbol is only usable if most of its history survives the join. 0.80 is a judgment call and
    // is stated as one: it admits the ~2 dirty months at the end of the local snapshot and rejects a
    // symbol whose archive diverges early, which would mean something other than mid-bar writes.
    const MIN_PREFIX_FRAC = 0.80;
    const provenance: Record<string, unknown> = {
        generatedFromDb: DB_PATH, joinedAgainst: V14_DIR,
        module: 'exportEnvelope.ts', gitSha: process.env.GIT_SHA ?? null,
        mlSource: mlPath ?? null, symbols: {} as Record<string, unknown>,
    };
    let ok = 0, failed = 0, truncated = 0;
    for (const symbol of symbols) {
        const t0 = Date.now();
        try {
            const res = exportEnvelope(db, symbol, { ml, limit });
            const j = joinToV14(symbol, res.csv);
            const frac = j.matched / Math.max(1, j.total);
            if (frac < MIN_PREFIX_FRAC || j.matched < 500) {
                throw new Error(`only ${j.matched}/${j.total} rows join (${(frac * 100).toFixed(1)}%) `
                    + `— first divergence ${j.firstBadTs}: ${j.reason}`);
            }
            writeFileSync(join(outDir, `${symbol}.csv`), truncateTo(res.csv, j.matched));
            const lastTs = Number(truncateTo(res.csv, j.matched).trim().split('\n').pop()!.split(',')[1]);
            (provenance.symbols as Record<string, unknown>)[symbol] = {
                rows: j.matched, produced: j.total, v14Rows: j.v14Rows,
                lastTs, truncatedAt: j.firstBadTs, truncationReason: j.reason,
            };
            const ms = Date.now() - t0;
            const note = j.reason ? `TRUNCATED at ${j.firstBadTs} (${j.reason.slice(0, 40)})` : 'full';
            console.log(`${symbol.padEnd(12)} ${String(j.matched).padStart(6)}/${String(j.total).padEnd(6)} rows  ${(ms / 1000).toFixed(1)}s  ${note}`);
            if (j.reason) truncated++;
            ok++;
        } catch (e) {
            console.error(`${symbol.padEnd(12)} FAILED — ${e instanceof Error ? e.message : e}`);
            failed++;
        }
    }
    writeFileSync(join(outDir, '_provenance.json'), JSON.stringify(provenance, null, 2));
    console.log(`\n${ok} exported (${truncated} truncated at the archive's dirty tail), ${failed} failed → ${outDir}`);
    if (failed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('exportEnvelope.ts')) main();
