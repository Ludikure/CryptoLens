// Shapes returned by the Worker's /indicators and /full-analysis. Loosely typed — only the
// fields the web UI reads today. The Worker is the source of truth (indicators-full.ts / prompt.ts).

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

export interface IndicatorTF {
  label: string; price: number; bias: string; bullPercent: number; biasScore: number;
  rsi: number | null;
  stochRSI: { k: number; d: number; crossover: string | null } | null;
  macd: { histogram: number; crossover: string | null };
  adx: { adx: number; plusDI: number; minusDI: number; strength: string; direction: string } | null;
  bollingerBands: { percentB: number; squeeze: boolean; bandwidth: number; upper: number | null; middle: number | null; lower: number | null } | null;
  atr: { atr: number; atrPercent: number } | null;
  ema20: number | null; ema50: number | null; ema200: number | null; vwap: number | null;
  supportResistance: { supports: number[]; resistances: number[] };
  volumeRatio: number | null; divergence: string | null;
  atrPercentile: number | null; atrPercentileLabel: string | null;
  candles: Candle[];
  ema20Series: number[]; ema50Series: number[]; ema200Series: number[];
  rsiSeries: number[]; stochKSeries: number[]; stochDSeries: number[];
  macdHistSeries: number[]; macdLineSeries: number[]; macdSignalSeries: number[];
  adxSeries: number[]; plusDISeries: number[]; minusDISeries: number[]; volumeRatioSeries: number[];
}

export interface IndicatorsResponse {
  symbol: string; isCrypto: boolean; timestamp: number;
  livePrice?: number | null;   // real-time ticker (indicators use closed candles → daily.price is the last close)
  daily: IndicatorTF; fourH: IndicatorTF | null; oneH: IndicatorTF | null;
  error?: string;
}

// /ml-predict — the cron-cached ML for a symbol (5-min TTL). 404 when no cron has scored it.
export interface MlPredict {
  symbol: string; probability: number; probabilityH72?: number | null; pUp?: number | null;
  timestamp: number; isCrypto: boolean;
}

export interface TradeSetup {
  direction: string; entry: number; stopLoss: number; tp1: number; tp2: number | null;
  reasoning?: string; suggestedQty?: number;
}

export interface FullAnalysisResponse {
  symbol: string; isCrypto: boolean; timestamp: number; model: string;
  analysis: string; setups: TradeSetup[];
  ml: { win: number | null; persistence: number | null; directionUp: number | null;
        bigMove: { prob: number; bucket: 'HIGH' | 'ELEVATED' | 'NORMAL'; multiple: number } | null };
  vol: { horizons: Record<string, { sigma: number; s1: [number, number]; s2: [number, number]; s99: [number, number] }>;
         rv: { h24: number; d7: number; d30: number } } | null;
  riskStates?: Array<{ state: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; detail: string; validated: boolean }>;
  bias: { daily: string; fourH: string | null; oneH: string | null };
  error?: string;
}

// /market — parsed enrichment for the Market tab (no LLM). Crypto-only fields null for stocks.
export interface MarketData {
  symbol: string; isCrypto: boolean; timestamp: number;
  derivatives: {
    fundingRatePercent: number; avgFundingRate: number; openInterestUSD: number;
    oiChange4h: number | null; oiChange24h: number | null;
    globalLongPercent: number; globalShortPercent: number;
    topTraderLongPercent: number; topTraderShortPercent: number; takerBuySellRatio: number;
  } | null;
  positioning: {
    fundingSentiment: string; oiTrend: string; crowding: string; smartMoneyBias: string;
    takerPressure: string; squeezeRisk: { level: string; direction: string };
    signals: Array<{ strength: string; message: string }>;
  } | null;
  spotPressure: { takerBuyRatio: number; takerBuyLabel: string; cvd24h: number; cvdTrend: string; bookRatio: number | null; bookLabel: string | null } | null;
  sentiment: { priceChangePercentage24h?: number | null; priceChangePercentage7d?: number | null; priceChangePercentage30d?: number | null; athChangePercentage: number } | null;
  crossAsset: { summary: string; dxyTrend: string; spyTrend: string; dxyPrice: number; spyPrice: number } | null;
  macro: { vix?: number | null; treasury10Y?: number | null; treasury2Y?: number | null; yieldSpread?: number | null; fedFundsRate?: number | null; usdIndex?: number | null } | null;
  fearGreed: { value: number; label: string } | null;
  economicEvents?: EconomicEventItem[];
  stockInfo?: {
    marketState: string; peRatio: number | null; eps: number | null; dividendYield: number | null;
    fiftyTwoWeekLow: number; fiftyTwoWeekHigh: number; sector: string | null; earningsDate: number | null;
    analystTargetMean: number | null; analystCount: number | null; analystRating: string | null;
    revenueGrowthYoY: number | null; earningsGrowthYoY: number | null; beta: number | null;
    exDividendDate: number | null; dividendRate: number | null;
  } | null;
  stockSentiment?: {
    vix: number | null; vixLevel: string; shortPercentOfFloat: number | null; shortRatio: number | null; fiftyTwoWeekPosition: number; putCallRatio: number | null;
  } | null;
}

export interface EconomicEventItem {
  title: string; country: string; impact: string;
  isHighImpact: boolean; isUpcoming: boolean; isRecentlyReleased: boolean;
  date: number; actual: string | null; forecast: string | null; previous: string | null; surprise: string | null;
}

// /direction-accuracy — live dual-gate direction-model track record (universe-wide, forward).
export interface DirectionAccuracy {
  overall: { resolved: number; correct?: number; accuracy: number | null; longs?: number; shorts?: number };
  byConfidence: Array<{ band: string; n: number; accuracy: number }>;
  byDirection: Array<{ predicted_dir: number; n: number; accuracy: number }>;
  bySymbol: Array<{ symbol: string; n: number; correct: number; accuracy: number; longs: number; long_correct: number; shorts: number; short_correct: number }>;
  pending: number;
  pendingSignals: Array<{ symbol: string; fired_at: number; entry_price: number; p_up: number; predicted_dir: number; ml_win: number; resolve_at: number }>;
  recent: Array<{ symbol: string; fired_at: number; p_up: number; predicted_dir: number; ml_win: number; fwd_return: number; correct: number }>;
  backtestBaseline: number;
}

// /ml-calibration — realized goodR rate by predicted-probability bucket (drift detector).
export interface MlCalibration {
  buckets: Array<{ bucket: string; n: number; predicted: number; realized: number }>;
  resolved: number;
  pending: number;
}
