import Foundation

enum MACD {
    /// Shared computation of MACD line and signal line from closes.
    private static func computeLines(closes: [Double], fast: Int = 12, slow: Int = 26, signal: Int = 9) -> (macdLine: [Double], signalLine: [Double])? {
        let emaFast = MovingAverages.computeEMA(values: closes, period: fast)
        let emaSlow = MovingAverages.computeEMA(values: closes, period: slow)
        guard !emaFast.isEmpty, !emaSlow.isEmpty else { return nil }

        let minLen = min(emaFast.count, emaSlow.count)
        var macdLine = [Double]()
        for i in 0..<minLen {
            macdLine.append(emaFast[emaFast.count - minLen + i] - emaSlow[emaSlow.count - minLen + i])
        }
        guard macdLine.count >= signal else { return nil }

        let signalLine = MovingAverages.computeEMA(values: macdLine, period: signal)
        guard !signalLine.isEmpty else { return nil }

        return (macdLine, signalLine)
    }

    static func compute(closes: [Double], fast: Int = 12, slow: Int = 26, signal: Int = 9) -> MACDResult? {
        guard let (macdLine, signalLine) = computeLines(closes: closes, fast: fast, slow: slow, signal: signal) else { return nil }

        let rawMacd = macdLine.last!
        let rawSignal = signalLine.last!
        let macdVal = rawMacd.rounded(toPlaces: 2)
        let signalVal = rawSignal.rounded(toPlaces: 2)
        let histogram = (rawMacd - rawSignal).rounded(toPlaces: 2)  // from raw values to avoid compounding rounding

        var crossover: String? = nil
        if macdLine.count >= 2, signalLine.count >= 2 {
            let prevMacd = macdLine[macdLine.count - 2]
            let prevSignal = signalLine[signalLine.count - 2]
            // Use unrounded values for consistent crossover detection
            if prevMacd <= prevSignal && rawMacd > rawSignal {
                crossover = "bullish"
            } else if prevMacd >= prevSignal && rawMacd < rawSignal {
                crossover = "bearish"
            }
        }

        return MACDResult(macd: macdVal, signal: signalVal, histogram: histogram, crossover: crossover)
    }

    /// Returns last N MACD histogram values.
    static func computeHistSeries(closes: [Double], count: Int = 10, fast: Int = 12, slow: Int = 26, signal: Int = 9) -> [Double] {
        guard let (macdLine, signalLine) = computeLines(closes: closes, fast: fast, slow: slow, signal: signal) else { return [] }

        let histLen = min(macdLine.count, signalLine.count)
        var hist = [Double]()
        for i in 0..<histLen {
            hist.append((macdLine[macdLine.count - histLen + i] - signalLine[signalLine.count - histLen + i]).rounded(toPlaces: 2))
        }
        return Array(hist.suffix(count))
    }

    /// Returns full MACD line + signal line series (last N values each).
    static func computeFullSeries(closes: [Double], count: Int = 50, fast: Int = 12, slow: Int = 26, signal: Int = 9) -> (macdLine: [Double], signalLine: [Double]) {
        guard let (macd, sig) = computeLines(closes: closes, fast: fast, slow: slow, signal: signal) else { return ([], []) }
        // Align: both series end at the same bar, take last N
        let alignLen = min(macd.count, sig.count)
        let macdAligned = Array(macd.suffix(alignLen).suffix(count))
        let sigAligned = Array(sig.suffix(alignLen).suffix(count))
        return (macdAligned, sigAligned)
    }
}
