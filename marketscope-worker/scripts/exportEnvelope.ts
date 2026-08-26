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
const V14_COL = { ts: 1, price: 2, atrPercentile: 13, dRsi: 14, hRsi: 33, fundingRateRaw: 61 } as const;

export interface V14Row {
    ts: number; price: number; atrPercentile: number; dRsi: number; hRsi: number;
    /**
     * v14's `fundingRateRaw`, which despite the name is ALREADY IN PERCENT — `scripts/derivatives.ts`
     * documents the column as "% (already x 100)", and the values bear it out (0.01 is the classic
     * 0.01% baseline, not a 1% one). It maps DIRECTLY onto `DerivativesData.fundingRatePercent`;
     * multiplying by 100 "to convert" would be a 100x error, which is precisely the unit trap the
     * name invites.
     */
    fundingPct: number;
}
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
            fundingPct: Number(c[V14_COL.fundingRateRaw]),
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
// Removed-but-still-computed conditions. Empty outside their domain (the kill block only runs on
// counter-trend-pullback bars) — an empty cell is NOT a zero, and a consumer must not read it as one.
const DIAGS = ['killFunding', 'killVolume', 'killMacro', 'killDivergence'] as const;

const HEADER = ['symbol', 'timestamp', 'price', 'rawMlPct', 'mlPct', 'maxAllowed',
    'autoFlat', 'highBlocks', 'moderateBlocks', 'downgrade', ...FIELDS,
    'dRsi', 'hRsi', 'atrPct', ...DIAGS].join(',');

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
    // FUNDING IS NOT OPTIONAL DRESSING — it is the third continuation signal (`prompt.ts:1038`), and
    // without it `continuationCount` cannot exceed 2. Measured on ADAUSDT before this was wired in:
    // 34.9% / 61.8% / 3.2% / 0.0% across counts 0-3, i.e. an export that silently reproduced the
    // STOCK degeneracy Part 9 found, on a crypto symbol, for the same structural reason. Taking it
    // from the v14 row rather than a second source means the export sees exactly what the training
    // row saw. A stored 0 means "no derivatives data" in this dataset, not "funding was flat".
    const fundingByTs = new Map(v14Rows.filter(r => r.fundingPct !== 0).map(r => [r.ts, r.fundingPct]));
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
        // runBacktest's own guard is `daily < 250 || fourH < 210`, but it slices the last 300 of
        // each. That gap is harmless when both runs read the same archive and fatal when they do
        // not: the local snapshot's daily history starts LATER than Vision's for several symbols
        // (ATOM 2019-05-28), so a 250-bar population is ranked against a different set than v14's
        // 300-bar one and `atrPercentile` lands a few points off — measured 10 vs 11 on ATOM, 77 vs
        // 82 on DASH. Requiring the FULL window on all three timeframes makes the slice "the last
        // 300 bars" in both runs regardless of how deep either archive goes, so the join is exact by
        // construction rather than by luck. It costs the warm-up bars, which the 80% floor absorbs.
        if (dailySlice.length < 300 || fourHSlice.length < 300 || oneHSlice.length < 300) { skipped++; continue; }

        const indicators: PromptIndicator[] = [
            computeFullIndicators(dailySlice, { timeframe: '1d', label: 'Daily', isCrypto }) as unknown as PromptIndicator,
            computeFullIndicators(fourHSlice, { timeframe: '4h', label: '4H', isCrypto }) as unknown as PromptIndicator,
            computeFullIndicators(oneHSlice, { timeframe: '1h', label: '1H', isCrypto }) as unknown as PromptIndicator,
        ];
        const tsSec = Math.floor(evalTime / 1000);
        const ml = opts.ml?.get(`${symbol}:${tsSec}`);
        if (ml != null) (indicators[0] as unknown as { mlWinProbability: number }).mlWinProbability = ml;

        const fundingPct = fundingByTs.get(tsSec);
        const r = buildUserPrompt({
            symbol, nowMs: evalTime + 14_400_000, indicators, prevState: state,
            economicEvents: [], calibratedMlWin: ml ?? null,
            // Only `fundingRatePercent` is real. The rest of `DerivativesData` is left at neutral
            // values because nothing the ENVELOPE reads touches them: `derivatives` is used in
            // exactly three places (`prompt.ts` 884 / 1038 / 1120), and of those only the
            // continuation signal feeds an envelope input. Verified by diffing ADAUSDT's export with
            // and without funding: `continuationCount` is the only INPUT that moves (29.1% of rows),
            // and it carries through to `moderateBlocks` (10.4%) and `maxAllowed` (8.7%). That last
            // number is the reason this is wired in rather than waved off — an envelope study run
            // without derivatives has the wrong conviction tier on about one bar in eleven.
            derivatives: fundingPct == null ? null : {
                fundingRatePercent: fundingPct, avgFundingRate: fundingPct,
                openInterestUSD: 0, globalLongPercent: 50, globalShortPercent: 50,
                topTraderLongPercent: 50, topTraderShortPercent: 50,
                takerBuySellRatio: 1, takerBuyVolume: 0,
            },
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
            ...DIAGS.map(k => (r.diagnostics?.[k] == null ? '' : String(r.diagnostics[k]))),
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
    kept: number;             // rows retained after truncation and row drops
    total: number;            // rows this run produced
    v14Rows: number;
    keepMask: boolean[];      // per produced row
    dropped: Array<{ ts: number; reason: string }>;
    truncatedAt: number | null;   // first ts of the trailing dirty run, if any
    truncationReason: string | null;
    longestBadRun: number;
}

/**
 * Compare an export against `csv_exports_v14` row by row, and separate the two failure modes the
 * real archive actually produces. They need opposite treatment, and telling them apart by DENSITY is
 * what makes that possible:
 *
 *  - ISOLATED BLIPS. One bar disagrees while its neighbours match. Measured on ATOMUSDT
 *    2021-10-29 04:00: local close 38.17 against v14's 38.14, normal volume, both adjacent bars
 *    exact. A single bad bar should cost that bar, not the 75% of history that follows it.
 *  - A DIRTY TAIL. The box snapshot carries mid-bar cron writes near its recent end, so rows go bad
 *    and stay bad. On ADAUSDT the 4H bar at 2026-04-14 00:00 is stored closing 0.2461 on 5.9M volume
 *    where the settled bar closed 0.2447 — and that settled close appears as the NEXT bar's open.
 *    Everything from there on is suspect and should be truncated away.
 *
 * A genuine SLICE error looks like neither: it is wrong on essentially every row, so it produces a
 * long bad run starting at the top, which truncates the export to nothing and trips the caller's
 * coverage floor. That is the intended outcome — the mutation tests cover it.
 */
export function joinToV14(symbol: string, csv: string, rows?: V14Row[], opts: { dirtyRun?: number } = {}): JoinReport {
    const v14 = rows ?? loadV14(symbol);
    if (!v14) throw new Error(`${symbol}: no csv_exports_v14/${symbol}.csv to join against`);
    const head = csv.trim().split('\n')[0].split(',');
    const ix = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`missing column ${n}`); return i; };
    const [cTs, cPx, cDRsi, cHRsi, cAtr] = ['timestamp', 'price', 'dRsi', 'hRsi', 'atrPct'].map(ix);
    const mine = csv.trim().split('\n').slice(1).map(l => l.split(','));
    if (!mine.length) throw new Error(
        `${symbol}: exported 0 rows. Every bar hit the warm-up guard (full 300-bar windows on all `
        + `three timeframes), which means the eval window starts before the local archive warms up.`);

    const byTs = new Map(v14.map(r => [r.ts, r]));
    // v14 rounds the indicator columns to 1 dp, so 0.051 is the quantisation floor. It is NOT widened
    // past that: the daily-leak mutation — restoring the in-progress day, the 2026-06-02 defect —
    // shows up as only a 0.15 dRsi difference, so a "generous" tolerance would let the single most
    // expensive mistake available here pass unnoticed.
    const TOL = 0.051;
    const bad: Array<string | null> = mine.map(row => {
        const r = byTs.get(Number(row[cTs]));
        if (!r) return 'bar absent from csv_exports_v14 (eval window or warm-up guard differs)';
        // Both files store price at 4 decimals, so on a sub-dollar symbol that is 4 significant
        // digits: DOGE at 0.2998 quantises to 3.3e-4 relative. Accept one unit in the last stored
        // decimal OR 1e-6 relative, whichever is looser.
        const dPx = Math.abs(r.price - Number(row[cPx]));
        if (dPx > 1.01e-4 && dPx / Math.max(1e-12, Math.abs(r.price)) > 1e-6)
            return `price ${r.price} vs ${row[cPx]} — local candle archive disagrees`;
        for (const [name, mineV, v14V] of [
            ['dRsi', Number(row[cDRsi]), r.dRsi],
            ['hRsi', Number(row[cHRsi]), r.hRsi],
            ['atrPercentile', Number(row[cAtr]), r.atrPercentile],
        ] as Array<[string, number, number]>) {
            if (!Number.isFinite(mineV) || !Number.isFinite(v14V)) continue;
            if (Math.abs(mineV - v14V) > TOL) return `${name} ${v14V} vs ${mineV.toFixed(4)} — indicator window differs`;
        }
        return null;
    });

    // Longest run of consecutive bad rows, and where the FIRST run long enough to count as a dirty
    // region begins. Everything from there on is discarded rather than cherry-picked.
    const DIRTY_RUN = opts.dirtyRun ?? 20;
    let longestBadRun = 0, run = 0, dirtyStart: number | null = null;
    for (let k = 0; k < bad.length; k++) {
        if (bad[k]) {
            run++;
            if (run > longestBadRun) longestBadRun = run;
            if (run >= DIRTY_RUN && dirtyStart === null) dirtyStart = k - run + 1;
        } else run = 0;
    }

    const cutoff = dirtyStart ?? bad.length;
    const keepMask = mine.map((_, k) => k < cutoff && !bad[k]);
    const dropped = mine.map((row, k) => ({ k, ts: Number(row[cTs]), reason: bad[k] }))
        .filter(d => d.reason && d.k < cutoff)
        .map(d => ({ ts: d.ts, reason: d.reason as string }));

    return {
        kept: keepMask.filter(Boolean).length, total: mine.length, v14Rows: v14.length,
        keepMask, dropped, longestBadRun,
        truncatedAt: dirtyStart === null ? null : Number(mine[dirtyStart][cTs]),
        truncationReason: dirtyStart === null ? null : bad[dirtyStart],
    };
}

/** Strict form: every produced row must agree. Used by tests and anything that cannot drop rows. */
export function assertJoinsV14(symbol: string, csv: string, rows?: V14Row[]): { matched: number; v14Only: number } {
    const j = joinToV14(symbol, csv, rows, { dirtyRun: 1 });
    if (j.kept !== j.total) {
        const first = j.dropped[0] ?? { ts: j.truncatedAt, reason: j.truncationReason ?? 'trailing dirty region' };
        throw new Error(`${symbol}: join failed at ${first.ts} — ${first.reason}`);
    }
    return { matched: j.kept, v14Only: j.v14Rows - j.kept };
}

/** Keep the rows the join retained. */
export function applyKeepMask(csv: string, keepMask: boolean[]): string {
    const lines = csv.trim().split('\n');
    return [lines[0], ...lines.slice(1).filter((_, k) => keepMask[k])].join('\n') + '\n';
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
    // Both floors are judgment calls and are stated as such. 0.80 admits the ~2 dirty months at the
    // end of the local snapshot; 2% admits the handful of isolated bad bars the archive contains
    // (ATOM has one at 2021-10-29) while rejecting a symbol that disagrees pervasively.
    const MIN_KEPT_FRAC = 0.80, MAX_DROP_RATE = 0.02;
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
            const frac = j.kept / Math.max(1, j.total);
            // Two independent floors. Coverage rejects a symbol whose archive is broadly unusable —
            // including a genuine slice error, which is bad on every row and so truncates to nothing.
            // The drop RATE rejects one that is riddled with blips even if the tail is clean: a few
            // scattered bad bars is an archive artefact, hundreds is a systematic disagreement
            // wearing an isolated-looking mask.
            if (frac < MIN_KEPT_FRAC || j.kept < 500) {
                throw new Error(`only ${j.kept}/${j.total} rows usable (${(frac * 100).toFixed(1)}%) `
                    + `— longest bad run ${j.longestBadRun}`
                    + (j.truncatedAt ? `, dirty from ${j.truncatedAt}` : '')
                    + (j.dropped[0] ? `, first blip ${j.dropped[0].ts}: ${j.dropped[0].reason}` : ''));
            }
            const dropRate = j.dropped.length / Math.max(1, j.total);
            if (dropRate > MAX_DROP_RATE) {
                throw new Error(`${j.dropped.length} scattered mismatches (${(dropRate * 100).toFixed(2)}%) `
                    + `exceed the ${(MAX_DROP_RATE * 100).toFixed(1)}% blip budget — first ${j.dropped[0].ts}: ${j.dropped[0].reason}`);
            }
            const outCsv = applyKeepMask(res.csv, j.keepMask);
            writeFileSync(join(outDir, `${symbol}.csv`), outCsv);
            const lastTs = Number(outCsv.trim().split('\n').pop()!.split(',')[1]);
            (provenance.symbols as Record<string, unknown>)[symbol] = {
                rows: j.kept, produced: j.total, v14Rows: j.v14Rows, lastTs,
                truncatedAt: j.truncatedAt, truncationReason: j.truncationReason, longestBadRun: j.longestBadRun,
                droppedBlips: j.dropped.length,
                droppedSample: j.dropped.slice(0, 20),
            };
            const ms = Date.now() - t0;
            const note = [
                j.truncatedAt ? `tail-truncated at ${j.truncatedAt}` : null,
                j.dropped.length ? `${j.dropped.length} blips dropped` : null,
            ].filter(Boolean).join(', ') || 'clean';
            console.log(`${symbol.padEnd(12)} ${String(j.kept).padStart(6)}/${String(j.total).padEnd(6)} rows  ${(ms / 1000).toFixed(1)}s  ${note}`);
            if (j.truncatedAt || j.dropped.length) truncated++;
            ok++;
        } catch (e) {
            console.error(`${symbol.padEnd(12)} FAILED — ${e instanceof Error ? e.message : e}`);
            failed++;
        }
    }
    writeFileSync(join(outDir, '_provenance.json'), JSON.stringify(provenance, null, 2));
    console.log(`\n${ok} exported (${truncated} needed truncation or blip drops), ${failed} failed → ${outDir}`);
    if (failed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('exportEnvelope.ts')) main();
