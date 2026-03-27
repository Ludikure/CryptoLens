import Foundation

enum BollingerBands {
    static func compute(closes: [Double], period: Int = 20, stdDev: Double = 2.0) -> BollingerResult? {
        guard closes.count >= period else { return nil }
        let window = Array(closes.suffix(period))
        let middle = window.reduce(0, +) / Double(period)
        let variance = window.reduce(0.0) { $0 + pow($1 - middle, 2) } / Double(period)
        let std = sqrt(variance)
        let upper = middle + stdDev * std
        let lower = middle - stdDev * std
        let current = closes.last!
        let percentB = (upper - lower) != 0 ? (current - lower) / (upper - lower) : 0.5
        let bandwidth = middle != 0 ? ((upper - lower) / middle) * 100.0 : 0

        // Squeeze: current bandwidth vs 120-period average bandwidth
        var squeeze = false
        if closes.count >= 120 {
            var bandwidths = [Double]()
            for i in 0..<120 {
                let idx = closes.count - 120 + i
                if idx >= period {
                    let w = Array(closes[(idx - period + 1)...idx])
                    let m = w.reduce(0, +) / Double(period)
                    let v = w.reduce(0.0) { $0 + pow($1 - m, 2) } / Double(period)
                    let s = sqrt(v)
                    let bw = m != 0 ? ((2.0 * stdDev * s) / m) * 100.0 : 0
                    bandwidths.append(bw)
                }
            }
            if !bandwidths.isEmpty {
                let avgBW = bandwidths.reduce(0, +) / Double(bandwidths.count)
                squeeze = bandwidth < avgBW * 0.5
            }
        }

        return BollingerResult(
            upper: upper.rounded(toPlaces: 2),
            middle: middle.rounded(toPlaces: 2),
            lower: lower.rounded(toPlaces: 2),
            percentB: percentB.rounded(toPlaces: 4),
            bandwidth: bandwidth.rounded(toPlaces: 4),
            squeeze: squeeze
        )
    }
}
