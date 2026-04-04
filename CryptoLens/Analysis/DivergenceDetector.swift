import Foundation

private struct DivSwingPoint {
    let index: Int
    let value: Double
}

enum DivergenceDetector {

    /// Find swing lows/highs using N-bar lookback
    private static func findSwings(values: [Double], isLow: Bool,
                                   lookback: Int = 2) -> [DivSwingPoint] {
        var points = [DivSwingPoint]()
        guard values.count > lookback * 2 else { return points }

        for i in lookback..<(values.count - lookback) {
            let isSwing: Bool
            if isLow {
                isSwing = (1...lookback).allSatisfy { values[i] <= values[i - $0] }
                       && (1...lookback).allSatisfy { values[i] <= values[i + $0] }
            } else {
                isSwing = (1...lookback).allSatisfy { values[i] >= values[i - $0] }
                       && (1...lookback).allSatisfy { values[i] >= values[i + $0] }
            }
            if isSwing {
                points.append(DivSwingPoint(index: i, value: values[i]))
            }
        }
        return points
    }

    /// Check for divergence between price and RSI.
    /// Returns true if divergence exists against the given bias direction.
    static func hasDivergence(candles: [Candle], rsiSeries: [Double],
                              biasDirection: String) -> Bool {
        guard candles.count >= 10, rsiSeries.count >= candles.count else { return false }

        if biasDirection.contains("Bearish") {
            // Check bullish divergence: price lower lows, RSI higher lows
            let priceLows = findSwings(values: candles.map(\.low), isLow: true, lookback: 2).suffix(2)
            guard priceLows.count == 2 else { return false }
            let pLows = Array(priceLows)

            let rsiAtFirst = rsiSeries[pLows[0].index]
            let rsiAtSecond = rsiSeries[pLows[1].index]

            return pLows[1].value < pLows[0].value && rsiAtSecond > rsiAtFirst + 2
        }

        if biasDirection.contains("Bullish") {
            // Check bearish divergence: price higher highs, RSI lower highs
            let priceHighs = findSwings(values: candles.map(\.high), isLow: false, lookback: 2).suffix(2)
            guard priceHighs.count == 2 else { return false }
            let pHighs = Array(priceHighs)

            let rsiAtFirst = rsiSeries[pHighs[0].index]
            let rsiAtSecond = rsiSeries[pHighs[1].index]

            return pHighs[1].value > pHighs[0].value && rsiAtSecond < rsiAtFirst - 2
        }

        return false
    }
}
