import Foundation

enum MovingAverages {
    /// EMA returning full series. Initial EMA = SMA of first `period` values.
    static func computeEMA(values: [Double], period: Int) -> [Double] {
        guard values.count >= period else { return [] }
        let multiplier = 2.0 / Double(period + 1)
        let initial = values[..<period].reduce(0, +) / Double(period)
        var ema = [initial]
        for i in period..<values.count {
            let next = (values[i] - ema.last!) * multiplier + ema.last!
            ema.append(next)
        }
        return ema
    }

    /// SMA of the last `period` values.
    static func computeSMA(values: [Double], period: Int) -> Double? {
        guard values.count >= period else { return nil }
        return values.suffix(period).reduce(0, +) / Double(period)
    }
}
