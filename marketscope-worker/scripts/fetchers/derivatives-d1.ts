// One-shot dump of D1 derivatives_history via `wrangler d1 execute --json`. Returns a
// per-symbol map of 4H-aligned bars. The D1 archive only goes back ~7 months (the
// cron writes one row per ~4H per symbol), but the fields that survive are richer
// than what Binance fapi exposes:
//   - top_trader_long_pct, taker_buy_vol, taker_sell_vol, basis_pct
//
// We use this as an OVERLAY on the Binance fapi merge: any field present in D1 wins.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { round4H } from './derivatives-binance.js';

const execFileP = promisify(execFile);

export interface D1DerivativesBar {
    timeMs: number;
    fundingRate?: number;       // raw (decimal, NOT × 100) — D1 stores as fapi returns it
    openInterest?: number;
    longPercent?: number;
    takerRatio?: number;        // = takerBuySellRatio
    topTraderLongPct?: number;
    takerBuyVol?: number;
    takerSellVol?: number;
    markPrice?: number;
    indexPrice?: number;
    basisPct?: number;
}

export type D1DerivativesArchive = Map<string, Map<number, D1DerivativesBar>>;

/// Run `wrangler d1 execute` once and return the full per-symbol archive. The D1
/// table is small (~92K rows) so we pull it all and partition in-memory.
export async function fetchD1DerivativesArchive(): Promise<D1DerivativesArchive> {
    const sql = `SELECT symbol, timestamp, funding_rate, open_interest, long_percent,
                        taker_ratio, top_trader_long_pct, taker_buy_vol, taker_sell_vol,
                        mark_price, index_price, basis_pct
                 FROM derivatives_history`;
    const { stdout } = await execFileP('npx', [
        'wrangler', 'd1', 'execute', 'marketscope-db', '--remote',
        '--json', '--command', sql,
    ], { maxBuffer: 256 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    const rows: any[] = parsed?.[0]?.results ?? [];
    const archive: D1DerivativesArchive = new Map();
    for (const row of rows) {
        const sym = row.symbol as string;
        if (!sym) continue;
        // D1 schema stores `timestamp` in seconds (matches the cron's archive insert).
        const tsMs = (row.timestamp as number) * 1000;
        const key = round4H(tsMs);
        const bar: D1DerivativesBar = {
            timeMs: key,
            fundingRate: row.funding_rate ?? undefined,
            openInterest: row.open_interest ?? undefined,
            longPercent: row.long_percent ?? undefined,
            takerRatio: row.taker_ratio ?? undefined,
            topTraderLongPct: row.top_trader_long_pct ?? undefined,
            takerBuyVol: row.taker_buy_vol ?? undefined,
            takerSellVol: row.taker_sell_vol ?? undefined,
            markPrice: row.mark_price ?? undefined,
            indexPrice: row.index_price ?? undefined,
            basisPct: row.basis_pct ?? undefined,
        };
        let bySym = archive.get(sym);
        if (!bySym) { bySym = new Map(); archive.set(sym, bySym); }
        // If multiple rows share a 4H bucket (rare — should be one per ~4H), latest wins.
        bySym.set(key, bar);
    }
    return archive;
}
