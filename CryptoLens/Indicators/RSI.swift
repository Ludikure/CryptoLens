import Foundation

enum RSI {
    /// RSI using Wilder's smoothing method.
    static func compute(closes: [Double], period: Int = 14) -> Double? {
        guard closes.count >= period + 1 else { return nil }
        var gains = [Double]()
        var losses = [Double]()
        for i in 1..<closes.count {
            let change = closes[i] - closes[i - 1]
            gains.append(max(0, change))
            losses.append(max(0, -change))
        }
        var avgGain = gains[..<period].reduce(0, +) / Double(period)
        var avgLoss = losses[..<period].reduce(0, +) / Double(period)
        for i in period..<gains.count {
            avgGain = (avgGain * Double(period - 1) + gains[i]) / Double(period)
            avgLoss = (avgLoss * Double(period - 1) + losses[i]) / Double(period)
        }
        guard avgLoss != 0 else { return 100.0 }
        return (100.0 - (100.0 / (1.0 + avgGain / avgLoss))).rounded(toPlaces: 2)
    }

    /// RSI series aligned with closes. First `period` entries are nil.
    static func computeSeries(closes: [Double], period: Int = 14) -> [Double?] {
        guard closes.count >= period + 1 else {
            return Array(repeating: nil, count: closes.count)
        }
        var result: [Double?] = Array(repeating: nil, count: period)
        var gains = [Double]()
        var losses = [Double]()
        for i in 1..<closes.count {
            let change = closes[i] - closes[i - 1]
            gains.append(max(0, change))
            losses.append(max(0, -change))
        }
        var avgGain = gains[..<period].reduce(0, +) / Double(period)
        var avgLoss = losses[..<period].reduce(0, +) / Double(period)
        if avgLoss == 0 {
            result.append(100.0)
        } else {
            result.append((100.0 - (100.0 / (1.0 + avgGain / avgLoss))).rounded(toPlaces: 2))
        }
        for i in period..<gains.count {
            avgGain = (avgGain * Double(period - 1) + gains[i]) / Double(period)
            avgLoss = (avgLoss * Double(period - 1) + losses[i]) / Double(period)
            if avgLoss == 0 {
                result.append(100.0)
            } else {
                result.append((100.0 - (100.0 / (1.0 + avgGain / avgLoss))).rounded(toPlaces: 2))
            }
        }
        return result
    }
}

extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let multiplier = pow(10.0, Double(places))
        return (self * multiplier).rounded() / multiplier
    }
}
