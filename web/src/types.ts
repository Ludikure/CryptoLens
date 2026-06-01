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
  daily: IndicatorTF; fourH: IndicatorTF | null; oneH: IndicatorTF | null;
  error?: string;
}

export interface TradeSetup {
  direction: string; entry: number; stopLoss: number; tp1: number; tp2: number | null;
  reasoning?: string; suggestedQty?: number;
}

export interface FullAnalysisResponse {
  symbol: string; isCrypto: boolean; timestamp: number; model: string;
  analysis: string; setups: TradeSetup[];
  ml: { win: number | null; persistence: number | null; directionUp: number | null };
  bias: { daily: string; fourH: string | null; oneH: string | null };
  error?: string;
}

// /direction-accuracy — live dual-gate direction-model track record (universe-wide, forward).
export interface DirectionAccuracy {
  overall: { resolved: number; correct?: number; accuracy: number | null; longs?: number; shorts?: number };
  byConfidence: Array<{ band: string; n: number; accuracy: number }>;
  byDirection: Array<{ predicted_dir: number; n: number; accuracy: number }>;
  bySymbol: Array<{ symbol: string; n: number; correct: number; accuracy: number; longs: number; long_correct: number; shorts: number; short_correct: number }>;
  pending: number;
  recent: Array<{ symbol: string; fired_at: number; p_up: number; predicted_dir: number; ml_win: number; fwd_return: number; correct: number }>;
  backtestBaseline: number;
}

// /ml-calibration — realized goodR rate by predicted-probability bucket (drift detector).
export interface MlCalibration {
  buckets: Array<{ bucket: string; n: number; predicted: number; realized: number }>;
  resolved: number;
  pending: number;
}
