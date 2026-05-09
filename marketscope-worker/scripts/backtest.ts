#!/usr/bin/env tsx
// CLI entry for the Node-based backtest pipeline. Replaces the iOS BacktestEngine for
// CSV generation: same column layout, parallel symbols, no simulator needed.
//
// Usage:
//   npm run backtest -- --symbol BTCUSDT --start 2020-01-01 --end 2025-01-01
//   npm run backtest -- --symbols BTCUSDT,ETHUSDT,DOGEUSDT --concurrency 5
//
// Phase 1 supports crypto only with stubbed sentiment/derivs/macro/cross-asset. Phases
// 2-4 wire those in; Phase 5 verifies parity vs Swift; Phase 6 polishes the runner.

import pLimit from 'p-limit';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { runBacktest } from './runBacktest.js';
import { fetchD1DerivativesArchive } from './fetchers/derivatives-d1.js';
import { fetchGlobalContext } from './context.js';

interface CliArgs {
    symbols: string[];
    startMs: number;
    endMs: number;
    outDir: string;
    concurrency: number;
    /// Set --no-d1 to skip the D1 derivatives archive dump. Useful for offline or
    /// CI environments without wrangler auth. Defaults to enabled.
    useD1: boolean;
    /// Set --no-resume to re-run symbols that already have a CSV in outDir.
    /// Default skips them — handy when a previous batch crashed midway.
    resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const opts: Record<string, string> = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
            opts[key] = 'true';
        } else {
            opts[key] = val;
            i++;
        }
    }
    const symbols = opts.symbol
        ? [opts.symbol.toUpperCase()]
        : (opts.symbols ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) {
        throw new Error('Pass --symbol BTCUSDT or --symbols BTC,ETH,...');
    }
    const start = opts.start ?? '2020-01-01';
    const end = opts.end ?? new Date().toISOString().slice(0, 10);
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw new Error(`Bad date: --start=${start} --end=${end}`);
    }
    const outDir = resolve(opts.out ?? '../ml-training/csv_exports_node');
    const concurrency = Math.max(1, parseInt(opts.concurrency ?? '3', 10));
    const useD1 = opts['no-d1'] !== 'true';
    const resume = opts['no-resume'] !== 'true';
    return { symbols, startMs, endMs, outDir, concurrency, useD1, resume };
}

async function fileExistsNonEmpty(path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        return s.isFile() && s.size > 0;
    } catch { return false; }
}

async function main() {
    const args = parseArgs(process.argv);
    console.log(`[backtest] ${args.symbols.length} symbol(s), concurrency=${args.concurrency}`);
    console.log(`[backtest] window: ${new Date(args.startMs).toISOString().slice(0, 10)} → ${new Date(args.endMs).toISOString().slice(0, 10)}`);
    console.log(`[backtest] out: ${args.outDir}`);

    // Resume mode: filter out symbols whose CSV already exists. Lets us recover from
    // a crash without redoing the long-history symbols (BTCUSDT etc. take 12+ min).
    let symbolsToRun = args.symbols;
    if (args.resume) {
        const existing: string[] = [];
        const fresh: string[] = [];
        for (const sym of args.symbols) {
            if (await fileExistsNonEmpty(`${args.outDir}/${sym}.csv`)) existing.push(sym);
            else fresh.push(sym);
        }
        if (existing.length > 0) {
            console.log(`[backtest] resume: skipping ${existing.length} symbol(s) already present (use --no-resume to force re-run)`);
        }
        symbolsToRun = fresh;
        if (symbolsToRun.length === 0) {
            console.log(`[backtest] nothing to do — all CSVs present`);
            return;
        }
    }

    // One-shot D1 archive dump so all symbols share the same recent-derivatives map.
    // ~92K rows takes a few seconds; saves N × wrangler invocations downstream.
    let d1Archive = null;
    const hasCrypto = symbolsToRun.some(s => s.endsWith('USDT'));
    if (args.useD1 && hasCrypto) {
        try {
            const t = Date.now();
            d1Archive = await fetchD1DerivativesArchive();
            console.log(`[backtest] D1 archive: ${d1Archive.size} symbols in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        } catch (e) {
            console.warn(`[backtest] D1 dump failed (${e instanceof Error ? e.message : e}) — falling back to fapi only`);
        }
    }

    // Shared global context: F&G, ETH/BTC, VIX, VIX3M, DXY for all runs; SPY, IWM,
    // sector ETFs, dark-pool history when stocks are present. Fetching once per run
    // (instead of per-symbol) saves N redundant Yahoo + alternative.me calls. The
    // window is padded by 365 days to match runBacktest's per-symbol warmup —
    // otherwise EMA-20 / DXY momentum / etc. start from a cold seed at args.startMs.
    const stockSymbols = symbolsToRun.filter(s => !s.endsWith('USDT'));
    const ctxStartMs = args.startMs - 365 * 86_400_000;
    const tCtx = Date.now();
    const sharedContext = await fetchGlobalContext(ctxStartMs, args.endMs, { stockSymbols });
    console.log(`[backtest] global context fetched in ${((Date.now() - tCtx) / 1000).toFixed(1)}s` +
        (stockSymbols.length ? ` (incl. ${sharedContext.sectorETFDaily.size} sector ETFs)` : ''));

    const limit = pLimit(args.concurrency);
    const t0 = Date.now();
    const results = await Promise.allSettled(
        symbolsToRun.map(sym => limit(async () => {
            const startedAt = Date.now();
            try {
                const result = await runBacktest({
                    symbol: sym,
                    startMs: args.startMs,
                    endMs: args.endMs,
                    outPath: `${args.outDir}/${sym}.csv`,
                    d1Derivatives: d1Archive,
                    sharedContext,
                });
                const dt = ((Date.now() - startedAt) / 1000).toFixed(1);
                console.log(`[${sym}] ✓ ${result.bars} rows → ${result.outPath} (${dt}s)`);
                return result;
            } catch (e) {
                const dt = ((Date.now() - startedAt) / 1000).toFixed(1);
                console.error(`[${sym}] ✗ ${e instanceof Error ? e.message : e} (${dt}s)`);
                throw e;
            }
        })),
    );

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[backtest] ${ok}/${results.length} succeeded in ${totalSec}s${failed ? ` (${failed} failed)` : ''}`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
    console.error('[backtest] fatal:', err);
    process.exit(1);
});
