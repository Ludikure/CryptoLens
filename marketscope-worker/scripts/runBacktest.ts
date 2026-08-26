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
import { visionKlines } from './fetchers/vision.js';
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
import {
    computeTimeframeBias, alignFromBiases, regimeFromDaily, emaRegimeFromDaily,
    CRYPTO_DEFAULT, STOCK_DEFAULT,
} from './scoring-bias.js';

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

/// Trade simulation port from BacktestEngine.swift:493-566. Runs only when bias is
/// aligned (bullish or bearish). Returns the CSV-label fields for tradeOutcome, pnl,
/// bars, peakFav, peakAdv. Neutral/conflict bars get the zero-row sentinel that Swift
/// emits via the `tradeResult == nil` branch (line 568).
interface TradeSimResult {
    outcome: string;
    pnlPct: number;
    barsToOutcome: number;
    maxFavorable: number;
    maxAdverse: number;
}

export function simulateTrade(
    alignment: string, isCrypto: boolean, fourHPrice: number, atrFor4H: number,
    oneHCandles: Candle[], firstFutureOneHIdx: number,
): TradeSimResult {
    const empty: TradeSimResult = {
        outcome: 'NONE', pnlPct: 0, barsToOutcome: 0, maxFavorable: 0, maxAdverse: 0,
    };
    if (!alignment.includes('bullish') && !alignment.includes('bearish')) return empty;
    if (atrFor4H <= 0) return empty;
    const isBull = alignment.includes('bullish');
    const slippagePct = isCrypto ? 0.00015 : 0.0003;
    const slippage = fourHPrice * slippagePct;
    const entry = isBull ? fourHPrice + slippage : fourHPrice - slippage;
    let stop = isBull ? entry - atrFor4H * 2 - slippage : entry + atrFor4H * 2 + slippage;
    const tp1 = isBull ? entry + atrFor4H * 2 - slippage : entry - atrFor4H * 2 + slippage;
    const tp2 = isBull ? entry + atrFor4H * 4 - slippage : entry - atrFor4H * 4 + slippage;
    const risk = Math.abs(entry - stop);

    const maxScan = 72;
    let outcome = 'EXPIRED';
    let bars = maxScan;
    let peakFav = 0, peakAdv = 0;
    let tp1Reached = false, tp1ReachedBar = 0;

    for (let b = 0; b < maxScan; b++) {
        const idx = firstFutureOneHIdx + b;
        if (idx >= oneHCandles.length) { bars = b; break; }
        const c = oneHCandles[idx];
        const fav = isBull ? c.high - entry : entry - c.low;
        const adv = isBull ? entry - c.low : c.high - entry;
        if (fav > peakFav) peakFav = fav;
        if (adv > peakAdv) peakAdv = adv;
        const stopHit = isBull ? c.low <= stop : c.high >= stop;
        const tp1Hit = isBull ? c.high >= tp1 : c.low <= tp1;
        const tp2Hit = isBull ? c.high >= tp2 : c.low <= tp2;
        if (stopHit && tp1Hit) {
            const distStop = Math.abs(c.open - stop);
            const distTp1 = Math.abs(c.open - tp1);
            if (distStop <= distTp1) { outcome = 'STOPPED'; bars = b + 1; break; }
            else { tp1Reached = true; tp1ReachedBar = b; stop = entry; }
        } else if (stopHit) { outcome = 'STOPPED'; bars = b + 1; break; }
        else if (tp1Hit && !tp1Reached) { tp1Reached = true; tp1ReachedBar = b; stop = entry; }
        if (tp2Hit) { outcome = 'TP2'; bars = b + 1; break; }
    }
    if (outcome === 'EXPIRED' && tp1Reached) {
        outcome = 'TP1'; bars = tp1ReachedBar + 1;
    }
    let pnl = 0;
    if (outcome === 'TP1') pnl = Math.abs(tp1 - entry) / entry * 100;
    else if (outcome === 'TP2') pnl = Math.abs(tp2 - entry) / entry * 100;
    else if (outcome === 'STOPPED') pnl = -risk / entry * 100;

    return { outcome, pnlPct: pnl, barsToOutcome: bars, maxFavorable: peakFav, maxAdverse: peakAdv };
}

/// First 1H candle index strictly after `evalTime`. Mirrors Swift's `oneHIdx` semantics
const FOUR_H_MS = 4 * 3_600_000;

/**
 * Index of the 1H bar OPENING exactly at `targetMs`, or -1 when the archive has no such bar.
 *
 * THE ANCHOR (fixed 2026-08-26, plan step 1.5). `simulateTrade` derives its entry from
 * `fourHAll[i].close` — the price at T+4h — but was handed the index of the
 * first bar strictly after `evalTime`, which is the bar at T+1h. So it scanned for stops and targets across three hours that had already
 * happened when the entry price came into existence: a stop could be "hit" by a low that occurred
 * BEFORE the trade could have been placed. This is the same defect that inverted the entry-discipline
 * finding in the Python layer, in TypeScript, and it contaminates the `trade*` columns of every v14
 * CSV.
 *
 * Not live damage — v14 excludes `trade*` from the feature list — but a loaded gun in the export.
 *
 * Exact match rather than "first at or after": if the hour that should open the trade is MISSING
 * from the archive, the honest answer is that this bar cannot be simulated. Snapping to a neighbour
 * would silently place the entry at a different time than the price it was priced from.
 */
export function oneHIndexAtExact(oneHCandles: Candle[], targetMs: number): number {
    let lo = 0, hi = oneHCandles.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const t = oneHCandles[mid].time;
        if (t === targetMs) return mid;
        if (t < targetMs) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

/// Direction-aware fwdMaxFavR matching BacktestEngine.swift:1022-1026. For aligned
/// bullish setups, only the upside excursion counts (long-trade favorable). For aligned
/// bearish, only downside. Neutral and conflict use max-of-both (the worker's prior
/// default behaviour) — this is the row-by-row "favorable" direction the goodR label
/// is derived from.
function computeFwdMaxFavRDirectional(
    fourHCandles: Candle[], i: number, lookahead: number, atrFor4H: number,
    alignment: string,
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
    if (alignment.includes('bearish')) return downMove / atrFor4H;
    if (alignment.includes('bullish')) return upMove / atrFor4H;
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
/**
 * Forward windows, counted in BARS — which is not the same thing as the hours in their names.
 *
 * MEASURED (2026-08-26, plan step 4.4) on the box archive, span from bar i to bar i+6:
 *
 *     BTCUSDT   median  24h   (p10  24h, p90  24h)   6 x 4h, exactly as the name says
 *     AAPL      median 120h   (p10  72h, p90 144h)   5 DAYS
 *     MSFT / JPM / XOM / SPY   identical to AAPL
 *
 * A stock "4H" bar is ET-session aggregated — two per 6.5h session — so six of them is three
 * TRADING sessions, which is 72-240 clock hours depending on weekends and holidays. `fwdReturn24H`
 * therefore measures a one-day return on crypto and a FIVE-day return on stocks, under one name and
 * one column index.
 *
 * Two consequences, both of which had already caused damage:
 *   - No crypto-vs-stock comparison of any forward metric is valid. Part 8's "the only finding that
 *     replicates across markets" compared a 24h crypto number against a 120h stock one.
 *   - `goodR = fwdMaxFavR >= 1.5` is the stock model's TARGET, so that model predicts a 1.5-ATR
 *     excursion within ~5 days, not within 24 hours as the docs and the prompt both said.
 *
 * NOT converted here. Changing the window would change every stock label and force a retrain, which
 * is a decision with its own evidence requirements. What ships instead is `fwdSpanHours`: the actual
 * elapsed clock time of each row's window, so the units are a recorded FACT rather than an inference
 * from a column name. That also makes the end-of-series truncation below self-describing — those
 * rows carry a visibly short span instead of silently reporting a clamped return.
 */
function computeFwdWindow24H(
    fourHCandles: Candle[], i: number,
): { maxUpPct: number; maxDownPct: number; r4H: number; r12H: number; r24H: number; spanHours: number } {
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
        spanHours: (fourHCandles[Math.min(i + 6, last)].time - fourHCandles[i].time) / 3_600_000,
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
        // Candles from Binance Vision dumps (fetchers/vision.ts) — api.binance.com is
        // HTTP-451 geoblocked from the dev Mac; Vision has full history + disk cache.
        const [d, h, o, dh] = await Promise.all([
            visionKlines(symbol, '1d', fetchStartMs, endMs),
            visionKlines(symbol, '4h', fetchStartMs, endMs),
            visionKlines(symbol, '1h', fetchStartMs, endMs),
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
        // Match BacktestEngine.swift:414-424 — pass only the last 300 bars per timeframe to
        // computeAllFeatures, not the full history. The percentile-style features
        // (atrPercentile, volScalar downstream) rank current ATR against the population
        // sliced in here; full-history population produced ~25pp drift vs Swift's 300.
        // LEAK FIX: drop the in-progress DAY. At an intraday 4H bar, the current day's daily
        // candle is the COMPLETE day — it contains the 4H bars *after* this one (the rest of
        // today), which overlap the 24h forward label. Live drops the in-progress daily
        // (dropInProgress); the backtest must too. Without this, daily features (dRsi/dRsiDelta/
        // dStochCross/dBBPercentB…) encode the answer. Crypto-fatal because price is continuous
        // (the leaked daily close ≈ the forward price); stocks were spared by overnight gaps.
        // Subtracting one day keeps only days fully closed before this bar — matching live.
        const dailyFull = sliceUpTo(dailyAll, evalTime - 86_400_000);
        const dailySlice = dailyFull.slice(Math.max(0, dailyFull.length - 300));
        const fourHSlice = fourHAll.slice(Math.max(0, i + 1 - 300), i + 1);
        const oneHFull = sliceUpTo(oneHAll, evalTime);
        const oneHSlice = oneHFull.slice(Math.max(0, oneHFull.length - 300));
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

        // Bias/score per timeframe via the iOS ScoringFunction port. crossAssetSignal
        // and derivativesCombined are BOTH stubbed at 0 here for parity with Swift's
        // training data: BacktestEngine.swift:416 calls IndicatorEngine.computeAll
        // without passing either argument, so the snapshot ScoringFunction sees has
        // crossAssetSignal=0 and derivativesCombinedSignal=0 — regardless of what
        // the CSV-output derivatives columns store. (MLFeatures uses derivCtx?.
        // combinedSignal for the CSV column at BacktestEngine.swift:695, but that
        // value never feeds back into the score.) Passing real values here breaks
        // parity by exactly the Layer 5/6 contribution magnitude.
        const scoringParams = isCrypto ? CRYPTO_DEFAULT : STOCK_DEFAULT;
        const zeroExt = { crossAssetSignal: 0, derivativesCombined: 0 };
        const dailyExt = zeroExt;
        const dailyBR = computeTimeframeBias(dailySlice, isCrypto, '1d', scoringParams, dailyExt);
        const fourHBR = computeTimeframeBias(fourHSlice, isCrypto, '4h', scoringParams, zeroExt);
        const oneHBR = oneHSlice.length >= 30
            ? computeTimeframeBias(oneHSlice, isCrypto, '1h', scoringParams, zeroExt)
            : { score: 0, bias: 'Neutral', emaRegime: 'mixed' as const, stackBullish: false, stackBearish: false, adx: 0, rsi: 50 };
        const biasAlignmentStr = alignFromBiases(dailyBR.bias, fourHBR.bias);
        const regimeStr = regimeFromDaily(dailyBR.adx, dailyBR.stackBullish, dailyBR.stackBearish);
        const emaRegimeStr = emaRegimeFromDaily(dailyBR.stackBullish, dailyBR.stackBearish);

        // Trade simulation — only fires on aligned bars; matches Swift's
        // tradeResult == nil semantics on neutral/conflict.
        // The trade opens at the CLOSE of this 4H bar, so the first hour it can be exposed to is the
        // one opening at T+4h — not T+1h, which is inside the signal bar itself.
        const firstOneH = oneHIndexAtExact(oneHAll, evalTime + FOUR_H_MS);
        const tradeSim = firstOneH < 0
            ? { outcome: 'NONE', pnlPct: 0, barsToOutcome: 0, maxFavorable: 0, maxAdverse: 0 }
            : simulateTrade(biasAlignmentStr, isCrypto, price, atrFor4H, oneHAll, firstOneH);

        const w24 = computeFwdWindow24H(fourHAll, i);
        // Direction-aware fwdMaxFavR mirrors BacktestEngine.swift:1022-1026 — long
        // setups use upMove, short setups use downMove, neutral keeps max-of-both.
        const fwdMaxFavR24 = computeFwdMaxFavRDirectional(fourHAll, i, 6, atrFor4H, biasAlignmentStr);
        const fwdMaxFavR48 = computeFwdMaxFavRDirectional(fourHAll, i, 12, atrFor4H, biasAlignmentStr);
        const fwdMaxFavR72 = computeFwdMaxFavRDirectional(fourHAll, i, 18, atrFor4H, biasAlignmentStr);
        const fwdR48H = fwdReturnAtBars(fourHAll, i, 12);
        const fwdR72H = fwdReturnAtBars(fourHAll, i, 18);

        const out: BarOutput = {
            symbol,
            timestampMs: evalTime,
            // The 4H bar closes where the NEXT one opens. Taken from the series rather than computed
            // as `evalTime + 4h` because a stock "4H" bar is ET-session aggregated and is not four
            // clock hours long — assuming it is would reintroduce the very inference this column
            // exists to remove.
            barCloseTimestampMs: i + 1 < fourHAll.length
                ? fourHAll[i + 1].time
                : evalTime + FOUR_H_MS,
            price,
            dailyScore: dailyBR.score, fourHScore: fourHBR.score, oneHScore: oneHBR.score,
            dailyBias: dailyBR.bias, fourHBias: fourHBR.bias, oneHBias: oneHBR.bias,
            biasAlignment: biasAlignmentStr,
            regime: regimeStr, emaRegime: emaRegimeStr,
            volScalar: features.volScalarML ?? 1.0,
            atrPercentile: features.atrPercentile ?? 50,
            isCrypto,
            features,
            tradeOutcome: tradeSim.outcome,
            tradePnlPct: tradeSim.pnlPct,
            tradeBarsToOutcome: tradeSim.barsToOutcome,
            tradeMaxFavorable: tradeSim.maxFavorable,
            tradeMaxAdverse: tradeSim.maxAdverse,
            fwdReturn4H: w24.r4H, fwdReturn12H: w24.r12H, fwdReturn24H: w24.r24H,
            fwdMaxUp24H: w24.maxUpPct, fwdMaxDown24H: w24.maxDownPct,
            fwdMaxFavR: fwdMaxFavR24,
            fwdMaxFavR48H: fwdMaxFavR48,
            fwdMaxFavR72H: fwdMaxFavR72,
            fwdReturn48H: fwdR48H,
            fwdReturn72H: fwdR72H,
            fwdSpanHours: w24.spanHours,
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
