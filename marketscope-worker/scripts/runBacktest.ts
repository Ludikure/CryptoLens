// Single-symbol backtest runner.
// Crypto path: candles from Binance, derivatives from Binance fapi + D1 archive,
//   sentiment = F&G + ETH/BTC, full PreviousSnapshot chain, forward-window outcomes.
// Stock path: candles from D1 archive (1d + 1h), 4H aggregated via ET trading-day
//   chunking, no derivatives, sentiment undefined, cross-asset (SPY/IWM/sector/DXY/
//   VIX/VIX3M) sliced from Yahoo daily, dark-pool from bundled JSON.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    computeAllFeatures,
    type Candle,
    type PreviousSnapshot,
    type FullFeatures,
    type DerivativesSignals,
    type SentimentSignals,
} from '../src/scoring-full.js';
import { aggregate1HTo4H_ET } from '../src/aggregation.js';
import { fetchBinanceKlines } from './fetchers/candles-binance.js';
import { fetchD1Candles } from './fetchers/candles-d1.js';
import { fetchYahooDaily, fetchYahoo1H } from './fetchers/yahoo.js';
import { lookupDarkPool } from './fetchers/dark-pool.js';

const YAHOO_1H_LIMIT_MS = 720 * 86_400_000;

/**
 * Stock 1H candles, stitching Yahoo (recent ≤720 days) with D1 (older history).
 * Yahoo is the live cron's source — using it for the recent window keeps the
 * backtester's data view aligned with what serving sees. D1 1H is the only
 * multi-year archive we have on the Mac side; falls back to it for anything
 * Yahoo's 730-day cap rejects. Dedupes on timestamp; Yahoo wins on overlap.
 */
async function fetchStock1H(symbol: string, fetchStartMs: number, endMs: number): Promise<Candle[]> {
    const yahooCutoff = Math.max(fetchStartMs, endMs - YAHOO_1H_LIMIT_MS + 86_400_000);
    const [yahoo, d1] = await Promise.all([
        fetchYahoo1H(symbol, yahooCutoff, endMs).catch(e => {
            console.warn(`[${symbol}] Yahoo 1H failed (${e instanceof Error ? e.message : e}) — falling back to D1 only`);
            return [] as Candle[];
        }),
        fetchStartMs < yahooCutoff
            ? fetchD1Candles(symbol, '1h', fetchStartMs, yahooCutoff)
            : Promise.resolve([] as Candle[]),
    ]);
    // Yahoo wins on any overlap (it's the source of truth — D1 may have stale mid-bar
    // writes from cron). De-dupe by timestamp.
    const seen = new Set(yahoo.map(c => c.time));
    const merged = [...d1.filter(c => !seen.has(c.time)), ...yahoo];
    merged.sort((a, b) => a.time - b.time);
    return merged;
}
import { CSV_HEADER, rowToCSV, type BarOutput } from './csv.js';
import { fetchGlobalContext, resolveBarContext, sliceSectorETF, type GlobalContext } from './context.js';
import { loadMergedDerivatives, resolveDerivativesAt } from './derivatives.js';
import type { D1DerivativesArchive } from './fetchers/derivatives-d1.js';

/// Neutral derivatives signals for stock bars. computeAllFeatures still wants this
/// struct populated; the model treats all-zero rows as "no derivatives info".
const STOCK_DERIV_SIGNALS: DerivativesSignals = {
    fundingSignal: 0, oiSignal: 0, takerSignal: 0,
    crowdingSignal: 0, derivativesCombined: 0,
    fundingRateRaw: 0, oiChangePct: 0,
    takerRatioRaw: 1.0, longPctRaw: 50,
};

export interface RunOpts {
    symbol: string;
    startMs: number;
    endMs: number;
    outPath: string;
    /// Optional pre-loaded D1 derivatives archive shared across symbols. Caller
    /// dumps once with `fetchD1DerivativesArchive()` and passes the same map to
    /// every symbol's run — saves N redundant D1 calls.
    d1Derivatives?: D1DerivativesArchive | null;
    /// Optional pre-loaded global context (F&G, ETH/BTC, VIX, VIX3M, DXY, SPY,
    /// IWM, sector ETFs, dark pool). When the CLI is running multiple symbols
    /// in parallel, fetching this once is N× faster than per-symbol fetches.
    /// If omitted, runBacktest fetches its own context just for this symbol.
    sharedContext?: GlobalContext | null;
}

/// Per-symbol mutable state threaded through the bar walker. Mirrors what BacktestEngine
/// tracks across iterations (lines 374-386): rate-of-change history, 1-bar deltas for
/// acceleration, and regime-change counter. The values stored here are *previous bar's*
/// outputs, used as inputs to the current bar's `computeAllFeatures` call.
interface WalkerState {
    /// Last 7 values of each indicator across previous bars, oldest first. When length < 7
    /// the corresponding *Delta features fall through to 0 (worker contract).
    dRsiHist7: number[];
    dAdxHist7: number[];
    hRsiHist7: number[];
    hAdxHist7: number[];
    hMacdHistHist7: number[];
    /// Most recent indicator values from the previous bar. Used by the next bar's 1-bar
    /// delta and acceleration calculations.
    lastDRsi?: number; lastDAdx?: number;
    lastHRsi?: number; lastHAdx?: number; lastHMacdHist?: number;
    /// 1-bar deltas computed *at the previous bar* (= prev_bar - prev_prev_bar). Consumed
    /// by acceleration features at the current bar. Undefined until two bars have been
    /// processed (matches BacktestEngine's `prev*Delta1` initialization at lines 992-994).
    lastHRsiD1?: number; lastHMacdD1?: number;
    lastDRsiD1?: number; lastDAdxD1?: number;
    /// Regime continuity: the previous bar's regimeCode and barsSinceRegimeChange so the
    /// next bar can decide whether to increment or reset its counter (scoring-full.ts:986).
    lastRegimeCode?: number;
    lastBarsSinceRegimeChange?: number;
    /// Rolling 4-bar funding rate window. Threaded into PreviousSnapshot.fundingHist so
    /// the fundingSlope feature in scoring-full.ts can do a 4-point regression.
    fundingHist: number[];
}

function emptyState(): WalkerState {
    return {
        dRsiHist7: [], dAdxHist7: [], hRsiHist7: [],
        hAdxHist7: [], hMacdHistHist7: [],
        fundingHist: [],
    };
}

/// Build the snapshot to feed into computeAllFeatures for the current bar. Returns
/// undefined on the very first bar (no history yet) — scoring-full.ts handles undefined
/// by defaulting all delta-derived features to 0.
function buildSnapshot(state: WalkerState): PreviousSnapshot | undefined {
    if (state.lastHRsi === undefined) return undefined;
    return {
        dRsi: state.lastDRsi ?? 50,
        dAdx: state.lastDAdx ?? 0,
        hRsi: state.lastHRsi ?? 50,
        hAdx: state.lastHAdx ?? 0,
        hMacdHist: state.lastHMacdHist ?? 0,
        hRsiD1: state.lastHRsiD1,
        hMacdD1: state.lastHMacdD1,
        dRsiD1: state.lastDRsiD1,
        dAdxD1: state.lastDAdxD1,
        dRsiHist7: state.dRsiHist7.length ? state.dRsiHist7.slice() : undefined,
        dAdxHist7: state.dAdxHist7.length ? state.dAdxHist7.slice() : undefined,
        hRsiHist7: state.hRsiHist7.length ? state.hRsiHist7.slice() : undefined,
        hAdxHist7: state.hAdxHist7.length ? state.hAdxHist7.slice() : undefined,
        hMacdHistHist7: state.hMacdHistHist7.length ? state.hMacdHistHist7.slice() : undefined,
        prevRegimeCode: state.lastRegimeCode,
        prevBarsSinceRegimeChange: state.lastBarsSinceRegimeChange,
        fundingHist: state.fundingHist.length ? state.fundingHist.slice() : undefined,
    };
}

/// Update walker state after computing features for a bar. Slides the 7-bar windows,
/// captures 1-bar deltas for the next iteration, and stores the regime counter.
function updateState(state: WalkerState, features: FullFeatures): void {
    // 1-bar deltas: current_bar - last_bar. These become hRsiD1/hMacdD1/etc. for the
    // *next* bar's acceleration calc. Mirrors BacktestEngine.swift:997-1002.
    const newHRsiD1 = state.lastHRsi !== undefined ? features.hRsi - state.lastHRsi : undefined;
    const newHMacdD1 = state.lastHMacdHist !== undefined ? features.hMacdHist - state.lastHMacdHist : undefined;
    const newDRsiD1 = state.lastDRsi !== undefined ? features.dRsi - state.lastDRsi : undefined;
    const newDAdxD1 = state.lastDAdx !== undefined ? features.dAdx - state.lastDAdx : undefined;

    // Slide the 7-bar windows. Append current value, shift oldest out if length > 7.
    pushAndTrim(state.dRsiHist7, features.dRsi, 7);
    pushAndTrim(state.dAdxHist7, features.dAdx, 7);
    pushAndTrim(state.hRsiHist7, features.hRsi, 7);
    pushAndTrim(state.hAdxHist7, features.hAdx, 7);
    pushAndTrim(state.hMacdHistHist7, features.hMacdHist, 7);

    state.lastDRsi = features.dRsi;
    state.lastDAdx = features.dAdx;
    state.lastHRsi = features.hRsi;
    state.lastHAdx = features.hAdx;
    state.lastHMacdHist = features.hMacdHist;
    state.lastHRsiD1 = newHRsiD1;
    state.lastHMacdD1 = newHMacdD1;
    state.lastDRsiD1 = newDRsiD1;
    state.lastDAdxD1 = newDAdxD1;
    state.lastRegimeCode = features.regimeCode;
    state.lastBarsSinceRegimeChange = features.barsSinceRegimeChange;
}

function pushAndTrim(arr: number[], v: number, max: number): void {
    arr.push(v);
    if (arr.length > max) arr.shift();
}

/// Compute forward-window outcomes from bar `i` over the next `lookahead` 4H bars.
/// Returns max-favorable excursion in ATR multiples (direction-agnostic = max of
/// up-move or down-move). Mirrors BacktestEngine.swift:1018-1026 with `alignment ==
/// neutral` semantics (we don't compute bias yet, so the direction-agnostic branch
/// applies).
function computeFwdMaxFavR(
    fourHCandles: Candle[], i: number, lookahead: number, atrFor4H: number,
): number {
    if (atrFor4H <= 0) return 0;
    const end = Math.min(i + lookahead, fourHCandles.length - 1);
    if (end <= i) return 0;
    const price = fourHCandles[i].close;
    let maxHigh = -Infinity, minLow = Infinity;
    for (let k = i + 1; k <= end; k++) {
        if (fourHCandles[k].high > maxHigh) maxHigh = fourHCandles[k].high;
        if (fourHCandles[k].low < minLow) minLow = fourHCandles[k].low;
    }
    if (maxHigh === -Infinity) return 0;
    const upMove = maxHigh - price;
    const downMove = price - minLow;
    return Math.max(upMove, downMove) / atrFor4H;
}

/// Close-to-close return at +N 4H bars from `i`, in pct. Clamps to series end so the
/// final bars don't crash the loop; rows past the lookahead get the same close repeatedly,
/// which is the right semantics for "this trade isn't resolvable yet" (fwdReturn shrinks
/// to 0 at the boundary).
function fwdReturnAtBars(fourHCandles: Candle[], i: number, bars: number): number {
    const last = fourHCandles.length - 1;
    const price = fourHCandles[i].close;
    const k = Math.min(i + bars, last);
    return ((fourHCandles[k].close - price) / price) * 100;
}

/// 24h-specific maxUp / maxDown / fwd return helper. Returns the same metrics that
/// BacktestEngine columns expose: maxHigh-price (%), price-maxLow (%), and the close-
/// to-close fwd return at the lookahead horizon.
function computeFwdWindow24H(
    fourHCandles: Candle[], i: number,
): { maxUpPct: number; maxDownPct: number; r4H: number; r12H: number; r24H: number } {
    const last = fourHCandles.length - 1;
    const price = fourHCandles[i].close;
    const r = (j: number) => {
        const k = Math.min(i + j, last);
        return ((fourHCandles[k].close - price) / price) * 100;
    };
    const fwdEnd = Math.min(i + 6, last);
    let maxHigh = price, minLow = price;
    for (let k = i + 1; k <= fwdEnd; k++) {
        if (fourHCandles[k].high > maxHigh) maxHigh = fourHCandles[k].high;
        if (fourHCandles[k].low < minLow) minLow = fourHCandles[k].low;
    }
    return {
        maxUpPct: ((maxHigh - price) / price) * 100,
        maxDownPct: ((price - minLow) / price) * 100,
        r4H: r(1), r12H: r(3), r24H: r(6),
    };
}

export async function runBacktest(opts: RunOpts): Promise<{ symbol: string; bars: number; outPath: string }> {
    const { symbol, startMs, endMs, outPath } = opts;
    const isCrypto = symbol.endsWith('USDT');

    // Pad fetch start by 365 days for indicator warmup. Mirrors BacktestEngine.swift:77
    // (`warmupDays = 365 * 86400`); the loop later starts evaluating at the first 4H
    // candle with `time >= startMs`. Without this padding, fiftyTwoWeekPct (which needs
    // ≥252 daily bars in lookback) and atrPercentile (which prefers ~250 bars) sit at
    // their default fallbacks for the first 50+ weeks of the requested window.
    const fetchStartMs = startMs - 365 * 86_400_000;

    // Candle fetch + crypto-only derivatives are the only things that differ per branch.
    // Everything below the fetch (the bar walker, feature compute, CSV write) is shared.
    let dailyAll: Candle[];
    let fourHAll: Candle[];
    let oneHAll: Candle[];
    let derivHistory: Awaited<ReturnType<typeof loadMergedDerivatives>> | null = null;
    if (isCrypto) {
        const [d, h, o, dh] = await Promise.all([
            fetchBinanceKlines(symbol, '1d', fetchStartMs, endMs),
            fetchBinanceKlines(symbol, '4h', fetchStartMs, endMs),
            fetchBinanceKlines(symbol, '1h', fetchStartMs, endMs),
            loadMergedDerivatives(symbol, fetchStartMs, endMs, opts.d1Derivatives ?? null),
        ]);
        dailyAll = d; fourHAll = h; oneHAll = o; derivHistory = dh;
    } else {
        // Daily from Yahoo (multi-year via period1/period2) — matches the live cron's
        // data source; D1 is a frozen snapshot from prior BacktestEngine runs and
        // would drift from current Yahoo (split/dividend adjustments). 1H stitched
        // from Yahoo (recent ≤720 days, source of truth) + D1 (older history).
        // 4H aggregated from 1H using the same ET-day chunking the live cron + iOS
        // use, so values match the parity-tested pipeline exactly.
        const [d, o] = await Promise.all([
            fetchYahooDaily(symbol, fetchStartMs, endMs),
            fetchStock1H(symbol, fetchStartMs, endMs),
        ]);
        dailyAll = d; oneHAll = o;
        fourHAll = aggregate1HTo4H_ET(oneHAll);
    }
    if (dailyAll.length < 250 || fourHAll.length < 250) {
        throw new Error(`${symbol}: insufficient candles (D=${dailyAll.length}, 4H=${fourHAll.length})`);
    }

    const ctx = opts.sharedContext
        ?? await fetchGlobalContext(fetchStartMs, endMs, isCrypto ? {} : { stockSymbols: [symbol] });

    // First 4H bar with time >= startMs (the user's requested eval window). Falls back
    // to 210 if startMs precedes the fetched range — matches BacktestEngine.swift:358.
    let evalStartIndex = fourHAll.findIndex(c => c.time >= startMs);
    if (evalStartIndex < 0) evalStartIndex = Math.max(210, fourHAll.length - 1);
    if (evalStartIndex < 210) evalStartIndex = 210;
    const lines: string[] = [CSV_HEADER];
    const state = emptyState();

    for (let i = evalStartIndex; i < fourHAll.length - 1; i++) {
        const evalTime = fourHAll[i].time;
        const dailySlice = sliceUpTo(dailyAll, evalTime);
        const fourHSlice = fourHAll.slice(0, i + 1);
        const oneHSlice = sliceUpTo(oneHAll, evalTime);
        if (dailySlice.length < 250 || fourHSlice.length < 210) continue;

        const snapshot = buildSnapshot(state);
        const barCtx = resolveBarContext(ctx, evalTime);

        // Crypto: live derivatives lookup + F&G/ETH-BTC sentiment with basisPct overlay.
        // Stock: neutral signals, undefined sentiment (matches cron line 2184 — stocks
        // don't carry F&G or ETH/BTC by design, those are crypto-specific signals).
        let derivSignals: DerivativesSignals;
        let sentiment: SentimentSignals | undefined;
        if (isCrypto && derivHistory) {
            const priceRising = i > 0 && fourHAll[i].close > fourHAll[i - 1].close;
            const deriv = resolveDerivativesAt(derivHistory, evalTime, priceRising, state.fundingHist);
            derivSignals = deriv.signals;
            sentiment = { ...barCtx.sentiment, basisPct: deriv.basisPct };
            state.fundingHist = deriv.fundingHistOut;
        } else {
            derivSignals = STOCK_DERIV_SIGNALS;
            sentiment = undefined;
        }

        // Stock-only cross-asset slices. Empty arrays passed for crypto (matches the
        // cron's `isCrypto ? undefined : ...` ternary at index.ts:2187).
        const spyCandlesSlice = isCrypto ? [] : barCtx.spyCandlesSlice;
        const iwmCandlesSlice = isCrypto ? [] : barCtx.iwmCandlesSlice;
        const sectorCandlesSlice = isCrypto ? [] : sliceSectorETF(barCtx, symbol, evalTime);
        const darkPool = (!isCrypto && barCtx.darkPool)
            ? lookupDarkPool(barCtx.darkPool, symbol, evalTime)
            : undefined;

        const features = computeAllFeatures(
            dailySlice,
            fourHSlice,
            oneHSlice,
            isCrypto,
            derivSignals,
            barCtx.macro,
            sentiment,
            snapshot,
            spyCandlesSlice,
            darkPool,
            iwmCandlesSlice,
            sectorCandlesSlice,
            barCtx.dxyCandlesSlice,
            barCtx.vix3mPrice,
            symbol,
            evalTime,
        );

        // Derive 4H ATR from atrPercent feature (atrPercent = atr/close * 100, 4dp-rounded).
        // Tiny rounding drift vs the raw ATR Swift uses (BacktestEngine.swift:1020), but
        // sub-percent in ATR-multiple terms — parity will tell us if it matters.
        const price = fourHAll[i].close;
        const atrFor4H = (features.atrPercent / 100) * price;

        const w24 = computeFwdWindow24H(fourHAll, i);
        const fwdMaxFavR24 = computeFwdMaxFavR(fourHAll, i, 6, atrFor4H);
        const fwdMaxFavR48 = computeFwdMaxFavR(fourHAll, i, 12, atrFor4H);
        const fwdMaxFavR72 = computeFwdMaxFavR(fourHAll, i, 18, atrFor4H);
        // Signed close-to-close returns at the longer horizons. Lets persistence
        // analysis check whether 24h direction matches 48h/72h direction (i.e. is
        // the model catching continuations or whipsaws).
        const fwdR48H = fwdReturnAtBars(fourHAll, i, 12);
        const fwdR72H = fwdReturnAtBars(fourHAll, i, 18);

        const out: BarOutput = {
            symbol,
            timestampMs: evalTime,
            price,
            // Score / bias / regime fields aren't in scoring-full.ts; not model inputs,
            // only labels. Stubbed neutral.
            dailyScore: 0, fourHScore: 0, oneHScore: 0,
            dailyBias: 'Neutral', fourHBias: 'Neutral', oneHBias: 'Neutral',
            biasAlignment: 'neutral',
            regime: 'NEUTRAL', emaRegime: 'NEUTRAL',
            volScalar: features.volScalarML ?? 1.0,
            atrPercentile: features.atrPercentile ?? 50,
            isCrypto,
            features,
            // Trade-outcome simulation (entry-to-stop-or-target) isn't ported — separate
            // BacktestEngine logic, only CSV labels.
            tradeOutcome: 'NONE', tradePnlPct: 0, tradeBarsToOutcome: 0,
            tradeMaxFavorable: 0, tradeMaxAdverse: 0,
            fwdReturn4H: w24.r4H, fwdReturn12H: w24.r12H, fwdReturn24H: w24.r24H,
            fwdMaxUp24H: w24.maxUpPct, fwdMaxDown24H: w24.maxDownPct,
            fwdMaxFavR: fwdMaxFavR24,
            fwdMaxFavR48H: fwdMaxFavR48,
            fwdMaxFavR72H: fwdMaxFavR72,
            fwdReturn48H: fwdR48H,
            fwdReturn72H: fwdR72H,
        };
        lines.push(rowToCSV(out));
        updateState(state, features);
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, lines.join('\n') + '\n');
    return { symbol, bars: lines.length - 1, outPath };
}

function sliceUpTo(candles: Candle[], evalTime: number): Candle[] {
    let lo = 0, hi = candles.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candles[mid].time <= evalTime) lo = mid + 1; else hi = mid;
    }
    return candles.slice(0, lo);
}
