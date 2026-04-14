import Foundation

/// Full computation result for StochasticRSI, containing both scalar result and full series.
struct StochasticRSIFull {
    let result: StochRSIResult?
    let kValues: [Double]
    let dValues: [Double]
}

enum StochasticRSI {
    /// Compute all StochRSI data once — scalar result + full K/D series.
    static func computeFull(closes: [Double], rsiPeriod: Int = 14, stochPeriod: Int = 14, kSmooth: Int = 3, dSmooth: Int = 3) -> StochasticRSIFull {
        let rsiSeries = RSI.computeSeries(closes: closes, period: rsiPeriod)
        let validRSI = rsiSeries.compactMap { $0 }
        guard validRSI.count >= stochPeriod else { return StochasticRSIFull(result: nil, kValues: [], dValues: []) }

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
        guard stochValues.count >= kSmooth else { return StochasticRSIFull(result: nil, kValues: [], dValues: []) }

        var kValues = [Double]()
        for i in (kSmooth - 1)..<stochValues.count {
            let window = Array(stochValues[(i - kSmooth + 1)...i])
            kValues.append(window.reduce(0, +) / Double(kSmooth))
        }
        guard kValues.count >= dSmooth else { return StochasticRSIFull(result: nil, kValues: kValues, dValues: []) }

        var dValues = [Double]()
        for i in (dSmooth - 1)..<kValues.count {
            let window = Array(kValues[(i - dSmooth + 1)...i])
            dValues.append(window.reduce(0, +) / Double(dSmooth))
        }

        guard let rawK = kValues.last, let rawD = dValues.last else { return StochasticRSIFull(result: nil, kValues: [], dValues: []) }

        var crossover: String? = nil
        if kValues.count >= 2, dValues.count >= 2 {
            let prevK = kValues[kValues.count - 2]
            let prevD = dValues[dValues.count - 2]
            // Use unrounded values for consistent crossover detection
            if prevK <= prevD && rawK > rawD {
                crossover = "bullish"
            } else if prevK >= prevD && rawK < rawD {
                crossover = "bearish"
            }
        }

        let result = StochRSIResult(k: rawK.rounded(toPlaces: 2), d: rawD.rounded(toPlaces: 2), crossover: crossover)
        return StochasticRSIFull(result: result, kValues: kValues, dValues: dValues)
    }

    static func compute(closes: [Double], rsiPeriod: Int = 14, stochPeriod: Int = 14, kSmooth: Int = 3, dSmooth: Int = 3) -> StochRSIResult? {
        computeFull(closes: closes, rsiPeriod: rsiPeriod, stochPeriod: stochPeriod, kSmooth: kSmooth, dSmooth: dSmooth).result
    }

    /// Returns (kSeries, dSeries) — last N values of smoothed K and D lines.
    static func computeSeries(closes: [Double], count: Int = 10, rsiPeriod: Int = 14, stochPeriod: Int = 14, kSmooth: Int = 3, dSmooth: Int = 3) -> (k: [Double], d: [Double]) {
        let full = computeFull(closes: closes, rsiPeriod: rsiPeriod, stochPeriod: stochPeriod, kSmooth: kSmooth, dSmooth: dSmooth)
        return (Array(full.kValues.suffix(count)), Array(full.dValues.suffix(count)))
    }
}
