import Foundation

enum MACD {
    static func compute(closes: [Double], fast: Int = 12, slow: Int = 26, signal: Int = 9) -> MACDResult? {
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

        let macdVal = macdLine.last!.rounded(toPlaces: 2)
        let signalVal = signalLine.last!.rounded(toPlaces: 2)
        let histogram = (macdVal - signalVal).rounded(toPlaces: 2)

        var crossover: String? = nil
        if macdLine.count >= 2, signalLine.count >= 2 {
            let prevMacd = macdLine[macdLine.count - 2]
            let prevSignal = signalLine[signalLine.count - 2]
            if prevMacd <= prevSignal && macdVal > signalVal {
                crossover = "bullish"
            } else if prevMacd >= prevSignal && macdVal < signalVal {
                crossover = "bearish"
            }
        }

        return MACDResult(macd: macdVal, signal: signalVal, histogram: histogram, crossover: crossover)
    }
}
