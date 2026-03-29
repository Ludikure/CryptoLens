import Foundation

enum StochasticRSI {
    static func compute(closes: [Double], rsiPeriod: Int = 14, stochPeriod: Int = 14, kSmooth: Int = 3, dSmooth: Int = 3) -> StochRSIResult? {
        let rsiSeries = RSI.computeSeries(closes: closes, period: rsiPeriod)
        let validRSI = rsiSeries.compactMap { $0 }
        guard validRSI.count >= stochPeriod else { return nil }

        var stochValues = [Double]()
        for i in (stochPeriod - 1)..<validRSI.count {
            let window = Array(validRSI[(i - stochPeriod + 1)...i])
            let rsiMin = window.min()!
            let rsiMax = window.max()!
            if rsiMax - rsiMin == 0 {
                stochValues.append(50.0)
            } else {
                stochValues.append(((validRSI[i] - rsiMin) / (rsiMax - rsiMin)) * 100.0)
            }
        }
        guard stochValues.count >= kSmooth else { return nil }

        var kValues = [Double]()
        for i in (kSmooth - 1)..<stochValues.count {
            let window = Array(stochValues[(i - kSmooth + 1)...i])
            kValues.append(window.reduce(0, +) / Double(kSmooth))
        }
        guard kValues.count >= dSmooth else { return nil }

        var dValues = [Double]()
        for i in (dSmooth - 1)..<kValues.count {
            let window = Array(kValues[(i - dSmooth + 1)...i])
            dValues.append(window.reduce(0, +) / Double(dSmooth))
        }

        let k = kValues.last!.rounded(toPlaces: 2)
        let d = dValues.last!.rounded(toPlaces: 2)

        var crossover: String? = nil
        if kValues.count >= 2, dValues.count >= 2 {
            let prevK = kValues[kValues.count - 2]
            let prevD = dValues[dValues.count - 2]
            if prevK <= prevD && k > d {
                crossover = "bullish"
            } else if prevK >= prevD && k < d {
                crossover = "bearish"
            }
        }

        return StochRSIResult(k: k, d: d, crossover: crossover)
    }

    /// Returns (kSeries, dSeries) — last N values of smoothed K and D lines.
    static func computeSeries(closes: [Double], count: Int = 10, rsiPeriod: Int = 14, stochPeriod: Int = 14, kSmooth: Int = 3, dSmooth: Int = 3) -> (k: [Double], d: [Double]) {
        let rsiSeries = RSI.computeSeries(closes: closes, period: rsiPeriod)
        let validRSI = rsiSeries.compactMap { $0 }
        guard validRSI.count >= stochPeriod else { return ([], []) }

        var stochValues = [Double]()
        for i in (stochPeriod - 1)..<validRSI.count {
            let window = Array(validRSI[(i - stochPeriod + 1)...i])
            let rsiMin = window.min()!
            let rsiMax = window.max()!
            stochValues.append(rsiMax - rsiMin == 0 ? 50.0 : ((validRSI[i] - rsiMin) / (rsiMax - rsiMin)) * 100.0)
        }
        guard stochValues.count >= kSmooth else { return ([], []) }

        var kValues = [Double]()
        for i in (kSmooth - 1)..<stochValues.count {
            let window = Array(stochValues[(i - kSmooth + 1)...i])
            kValues.append(window.reduce(0, +) / Double(kSmooth))
        }
        guard kValues.count >= dSmooth else { return ([], []) }

        var dValues = [Double]()
        for i in (dSmooth - 1)..<kValues.count {
            let window = Array(kValues[(i - dSmooth + 1)...i])
            dValues.append(window.reduce(0, +) / Double(dSmooth))
        }

        return (Array(kValues.suffix(count)), Array(dValues.suffix(count)))
    }
}
