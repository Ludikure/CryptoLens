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
  adxSeries: number[]; volumeRatioSeries: number[];
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
