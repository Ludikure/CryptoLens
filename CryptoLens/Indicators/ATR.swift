import Foundation

enum ATR {
    static func compute(highs: [Double], lows: [Double], closes: [Double], period: Int = 14) -> ATRResult? {
        guard closes.count >= period + 1 else { return nil }
        var trueRanges = [Double]()
        for i in 1..<closes.count {
            let tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
            trueRanges.append(tr)
        }
        var atr = trueRanges[..<period].reduce(0, +) / Double(period)
        for i in period..<trueRanges.count {
            atr = (atr * Double(period - 1) + trueRanges[i]) / Double(period)
        }
        let current = closes.last!
        return ATRResult(
            atr: atr.rounded(toPlaces: 2),
            atrPercent: ((atr / current) * 100).rounded(toPlaces: 4),
            suggestedSLLong: (current - 1.5 * atr).rounded(toPlaces: 2),
            suggestedSLShort: (current + 1.5 * atr).rounded(toPlaces: 2)
        )
    }
}
