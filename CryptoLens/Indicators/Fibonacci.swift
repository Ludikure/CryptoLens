import Foundation

enum Fibonacci {
    static func compute(highs: [Double], lows: [Double], closes: [Double], lookback: Int = 50) -> FibResult? {
        guard closes.count >= lookback else { return nil }
        let recentHighs = Array(highs.suffix(lookback))
        let recentLows = Array(lows.suffix(lookback))
        let swingHigh = recentHighs.max()!
        let swingLow = recentLows.min()!
        let diff = swingHigh - swingLow
        guard diff != 0 else { return nil }

        let current = closes.last!
        let highIdx = recentHighs.firstIndex(of: swingHigh)!
        let lowIdx = recentLows.firstIndex(of: swingLow)!

        let trend: String
        var levels: [FibLevel]

        if lowIdx < highIdx {
            trend = "uptrend"
            levels = [
                FibLevel(name: "0.0 (swing high)", price: swingHigh.rounded(toPlaces: 2)),
                FibLevel(name: "0.236", price: (swingHigh - 0.236 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.382", price: (swingHigh - 0.382 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.5", price: (swingHigh - 0.5 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.618", price: (swingHigh - 0.618 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.786", price: (swingHigh - 0.786 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "1.0 (swing low)", price: swingLow.rounded(toPlaces: 2)),
            ]
        } else {
            trend = "downtrend"
            levels = [
                FibLevel(name: "0.0 (swing low)", price: swingLow.rounded(toPlaces: 2)),
                FibLevel(name: "0.236", price: (swingLow + 0.236 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.382", price: (swingLow + 0.382 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.5", price: (swingLow + 0.5 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.618", price: (swingLow + 0.618 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.786", price: (swingLow + 0.786 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "1.0 (swing high)", price: swingHigh.rounded(toPlaces: 2)),
            ]
        }

        let nearest = levels.min(by: { abs($0.price - current) < abs($1.price - current) })!

        return FibResult(
            trend: trend,
            swingHigh: swingHigh.rounded(toPlaces: 2),
            swingLow: swingLow.rounded(toPlaces: 2),
            levels: levels,
            nearestLevel: nearest.name,
            nearestPrice: nearest.price
        )
    }

    /// Compute Fibonacci from MarketStructure swing points (preferred).
    static func computeFromSwings(swingHighs: [Double], swingLows: [Double], closes: [Double]) -> FibResult? {
        guard let swingHigh = swingHighs.first,
              let swingLow = swingLows.first,
              let current = closes.last else { return nil }

        let diff = swingHigh - swingLow
        guard diff != 0 else { return nil }

        let trend: String
        var levels: [FibLevel]

        if current > (swingHigh + swingLow) / 2 {
            trend = "uptrend"
            levels = [
                FibLevel(name: "0.0 (swing high)", price: swingHigh.rounded(toPlaces: 2)),
                FibLevel(name: "0.236", price: (swingHigh - 0.236 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.382", price: (swingHigh - 0.382 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.5", price: (swingHigh - 0.5 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.618", price: (swingHigh - 0.618 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.786", price: (swingHigh - 0.786 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "1.0 (swing low)", price: swingLow.rounded(toPlaces: 2)),
            ]
        } else {
            trend = "downtrend"
            levels = [
                FibLevel(name: "0.0 (swing low)", price: swingLow.rounded(toPlaces: 2)),
                FibLevel(name: "0.236", price: (swingLow + 0.236 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.382", price: (swingLow + 0.382 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.5", price: (swingLow + 0.5 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.618", price: (swingLow + 0.618 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "0.786", price: (swingLow + 0.786 * diff).rounded(toPlaces: 2)),
                FibLevel(name: "1.0 (swing high)", price: swingHigh.rounded(toPlaces: 2)),
            ]
        }

        let nearest = levels.min(by: { abs($0.price - current) < abs($1.price - current) })!

        return FibResult(
            trend: trend,
            swingHigh: swingHigh.rounded(toPlaces: 2),
            swingLow: swingLow.rounded(toPlaces: 2),
            levels: levels,
            nearestLevel: nearest.name,
            nearestPrice: nearest.price
        )
    }
}
