import Foundation

struct MACDResult: Codable {
    let macd: Double
    let signal: Double
    let histogram: Double
    let crossover: String?
}

struct BollingerResult: Codable {
    let upper: Double
    let middle: Double
    let lower: Double
    let percentB: Double
    let bandwidth: Double
    let squeeze: Bool
}

struct ATRResult: Codable {
    let atr: Double
    let atrPercent: Double
    let suggestedSLLong: Double
    let suggestedSLShort: Double
}

struct StochRSIResult: Codable {
    let k: Double
    let d: Double
    let crossover: String?
}

struct ADXResult: Codable {
    let adx: Double
    let plusDI: Double
    let minusDI: Double
    let strength: String
    let direction: String
}

struct VWAPResult: Codable {
    let vwap: Double
    let priceVsVwap: String
    let distancePercent: Double
}

struct FibLevel: Codable {
    let name: String
    let price: Double
}

struct FibResult: Codable {
    let trend: String
    let swingHigh: Double
    let swingLow: Double
    let levels: [FibLevel]
    let nearestLevel: String
    let nearestPrice: Double
}

struct SRResult: Codable {
    let supports: [Double]
    let resistances: [Double]
}

struct PatternResult: Codable {
    let pattern: String
    let signal: String
}

struct IndicatorResult: Identifiable, Codable {
    let id: UUID
    let timeframe: String
    let label: String
    let price: Double
    let rsi: Double?
    let stochRSI: StochRSIResult?
    let macd: MACDResult?
    let adx: ADXResult?
    let bollingerBands: BollingerResult?
    let atr: ATRResult?
    let ema20: Double?
    let ema50: Double?
    let ema200: Double?
    let sma50: Double?
    let sma200: Double?
    let vwap: VWAPResult?
    let fibonacci: FibResult?
    let supportResistance: SRResult
    let candlePatterns: [PatternResult]
    let volumeRatio: Double?
    let divergence: String?
    let bias: String
    let bullPercent: Double

    init(timeframe: String, label: String, price: Double, rsi: Double?, stochRSI: StochRSIResult?, macd: MACDResult?, adx: ADXResult?, bollingerBands: BollingerResult?, atr: ATRResult?, ema20: Double?, ema50: Double?, ema200: Double?, sma50: Double?, sma200: Double?, vwap: VWAPResult?, fibonacci: FibResult?, supportResistance: SRResult, candlePatterns: [PatternResult], volumeRatio: Double?, divergence: String?, bias: String, bullPercent: Double) {
        self.id = UUID()
        self.timeframe = timeframe
        self.label = label
        self.price = price
        self.rsi = rsi
        self.stochRSI = stochRSI
        self.macd = macd
        self.adx = adx
        self.bollingerBands = bollingerBands
        self.atr = atr
        self.ema20 = ema20
        self.ema50 = ema50
        self.ema200 = ema200
        self.sma50 = sma50
        self.sma200 = sma200
        self.vwap = vwap
        self.fibonacci = fibonacci
        self.supportResistance = supportResistance
        self.candlePatterns = candlePatterns
        self.volumeRatio = volumeRatio
        self.divergence = divergence
        self.bias = bias
        self.bullPercent = bullPercent
    }
}
