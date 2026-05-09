// Backtest-time global context: F&G, ETH/BTC, VIX, VIX3M, DXY for crypto; same plus
// SPY, IWM, sector ETFs, and bundled dark-pool data for stocks. All fetched once per
// run and sliced per-bar by evalTime. Mirrors the live worker cron but historicized.

import { fetchFearGreedHistory, lookupFearGreed, type FearGreedPoint } from './fetchers/fear-greed.js';
import { fetchEthBtcFourH, lookupEthBtc } from './fetchers/eth-btc.js';
import { fetchYahooDaily, lookupClose, sliceUpToTime } from './fetchers/yahoo.js';
import { loadDarkPoolHistory, lookupDarkPool, type DarkPoolSeries } from './fetchers/dark-pool.js';
import { sectorETFForSymbol, type Candle, type MacroSignals, type SentimentSignals } from '../src/scoring-full.js';

export interface GlobalContext {
    fearGreed: FearGreedPoint[];
    ethBtcFourH: Candle[];
    vixDaily: Candle[];
    vix3mDaily: Candle[];
    dxyDaily: Candle[];
    /// Stock-only cross-asset slices. Empty for crypto-only runs.
    spyDaily: Candle[];
    iwmDaily: Candle[];
    /// Per-sector-ETF daily candles. Keyed by ETF symbol (e.g. "XLK"); pre-fetched for
    /// every sector touched by the run's stock symbol set.
    sectorETFDaily: Map<string, Candle[]>;
    darkPool: DarkPoolSeries | null;
}

export interface FetchOpts {
    /// Stock symbols to be backtested in this run; used to derive sector-ETF set so
    /// we don't fetch SPY/IWM/sector slices for a crypto-only run.
    stockSymbols?: string[];
}

export async function fetchGlobalContext(
    startMs: number, endMs: number, opts: FetchOpts = {},
): Promise<GlobalContext> {
    // Pull in parallel — independent endpoints. If any one fails, fall back to empty
    // (per-bar lookup returns neutral defaults so the run still produces a CSV).
    const settle = <T>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
        p.catch(e => { console.warn(`[context] ${label} fetch failed: ${e}`); return fallback; });

    const hasStocks = (opts.stockSymbols ?? []).length > 0;
    // Sector ETF set is the union of unique sectors touched by the run's stocks. ETF
    // symbols (SPY/QQQ/etc.) themselves return null from sectorETFForSymbol so they're
    // skipped — they're not mapped to a "parent" sector in the model.
    const neededSectors = new Set<string>();
    for (const s of opts.stockSymbols ?? []) {
        const etf = sectorETFForSymbol(s);
        if (etf) neededSectors.add(etf);
    }

    const [fearGreed, ethBtcFourH, vixDaily, vix3mDaily, dxyDaily, spyDaily, iwmDaily, darkPool, ...sectorList] =
        await Promise.all<any>([
            settle(fetchFearGreedHistory(), [] as FearGreedPoint[], 'fear-greed'),
            settle(fetchEthBtcFourH(startMs, endMs), [] as Candle[], 'eth-btc'),
            settle(fetchYahooDaily('^VIX', startMs, endMs), [] as Candle[], 'vix'),
            settle(fetchYahooDaily('^VIX3M', startMs, endMs), [] as Candle[], 'vix3m'),
            settle(fetchYahooDaily('DX-Y.NYB', startMs, endMs), [] as Candle[], 'dxy'),
            hasStocks ? settle(fetchYahooDaily('SPY', startMs, endMs), [] as Candle[], 'spy') : Promise.resolve([] as Candle[]),
            hasStocks ? settle(fetchYahooDaily('IWM', startMs, endMs), [] as Candle[], 'iwm') : Promise.resolve([] as Candle[]),
            hasStocks ? settle(loadDarkPoolHistory(), null as DarkPoolSeries | null, 'dark-pool') : Promise.resolve(null),
            ...Array.from(neededSectors).map(etf =>
                settle(fetchYahooDaily(etf, startMs, endMs), [] as Candle[], `sector:${etf}`),
            ),
        ]);

    const sectorETFDaily = new Map<string, Candle[]>();
    Array.from(neededSectors).forEach((etf, i) => {
        sectorETFDaily.set(etf, sectorList[i] as Candle[]);
    });

    return {
        fearGreed: fearGreed as FearGreedPoint[],
        ethBtcFourH: ethBtcFourH as Candle[],
        vixDaily: vixDaily as Candle[],
        vix3mDaily: vix3mDaily as Candle[],
        dxyDaily: dxyDaily as Candle[],
        spyDaily: spyDaily as Candle[],
        iwmDaily: iwmDaily as Candle[],
        sectorETFDaily,
        darkPool: darkPool as DarkPoolSeries | null,
    };
}

/// Per-bar context resolution. Slices the historical series at evalMs and computes
/// the scalar fields the worker scoring expects.
export interface BarContext {
    sentiment: SentimentSignals;
    macro: MacroSignals;
    dxyCandlesSlice: Candle[];
    vix3mPrice: number;
    /// Stock cross-asset slices — caller passes these straight to computeAllFeatures.
    /// Empty arrays for crypto bars or when fetch failed (lookups return neutral
    /// defaults inside scoring-full.ts).
    spyCandlesSlice: Candle[];
    iwmCandlesSlice: Candle[];
    /// Per-symbol — must be resolved at the runBacktest level (sectorETFForSymbol
    /// is symbol-specific). Caller looks up its symbol's sector then slices the
    /// per-ETF candle array via sliceUpToTime.
    sectorETFCandles: Map<string, Candle[]>;
    /// Bundled dark-pool series. null on crypto runs / load failure. Caller per-bar
    /// invokes lookupDarkPool with the symbol+evalMs to get {ratio, zscore}.
    darkPool: DarkPoolSeries | null;
}

export function resolveBarContext(global: GlobalContext, evalMs: number): BarContext {
    const fg = lookupFearGreed(global.fearGreed, evalMs);
    const eb = lookupEthBtc(global.ethBtcFourH, evalMs);
    const vix = lookupClose(global.vixDaily, evalMs) || 20;
    const dxyClose = lookupClose(global.dxyDaily, evalMs);
    const dxyEma20 = computeEma20AtTime(global.dxyDaily, evalMs);
    const dxyAboveEma20 = dxyClose > 0 && dxyEma20 > 0 && dxyClose > dxyEma20 ? 1 : 0;

    return {
        sentiment: {
            fearGreedIndex: fg.index,
            fearGreedZone: fg.zone,
            ethBtcRatio: eb.ratio,
            ethBtcDelta6: eb.delta6,
            // basisPct comes from Binance fapi premiumIndex history — Phase 3b deferred
            // (per-symbol fetch, not global). Keep at 0 for now; the basis features are
            // worth ~2 of 111 ML inputs so the cost of stubbing is small.
            basisPct: 0,
        },
        macro: { vix, dxyAboveEma20 },
        dxyCandlesSlice: sliceUpToTime(global.dxyDaily, evalMs),
        vix3mPrice: lookupClose(global.vix3mDaily, evalMs) || 0,
        spyCandlesSlice: sliceUpToTime(global.spyDaily, evalMs),
        iwmCandlesSlice: sliceUpToTime(global.iwmDaily, evalMs),
        // Pass the full per-ETF map untouched — the stock runner slices to evalMs after
        // looking up its symbol's sector. Slicing all sectors here would waste work for
        // every bar across every symbol.
        sectorETFCandles: global.sectorETFDaily,
        darkPool: global.darkPool,
    };
}

/// Convenience: slice a sector ETF's candle series up to evalMs. Returns empty when
/// the symbol has no sector mapping (ETFs like SPY itself, or unmapped symbols).
export function sliceSectorETF(
    ctx: BarContext, symbol: string, evalMs: number,
): Candle[] {
    const etf = sectorETFForSymbol(symbol);
    if (!etf) return [];
    const all = ctx.sectorETFCandles.get(etf);
    if (!all) return [];
    return sliceUpToTime(all, evalMs);
}

export { lookupDarkPool };

/// EMA-20 on daily closes up to and including evalMs. Matches scoring-full.ts's
/// `emaArray` — SMA seed of first `period` values, then exponential smoothing.
function computeEma20AtTime(candles: Candle[], evalMs: number): number {
    const slice = sliceUpToTime(candles, evalMs);
    const period = 20;
    if (slice.length < period) return 0;
    const closes = slice.map(c => c.close);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let ema = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * k + ema;
    }
    return ema;
}
