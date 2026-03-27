import Foundation

enum ADX {
    static func compute(highs: [Double], lows: [Double], closes: [Double], period: Int = 14) -> ADXResult? {
        guard closes.count >= period + 1 else { return nil }

        var plusDMList = [Double]()
        var minusDMList = [Double]()
        var trList = [Double]()

        for i in 1..<closes.count {
            let upMove = highs[i] - highs[i - 1]
            let downMove = lows[i - 1] - lows[i]
            plusDMList.append((upMove > downMove && upMove > 0) ? upMove : 0)
            minusDMList.append((downMove > upMove && downMove > 0) ? downMove : 0)
            trList.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
        }

        var smoothedPlus = plusDMList[..<period].reduce(0, +)
        var smoothedMinus = minusDMList[..<period].reduce(0, +)
        var smoothedTR = trList[..<period].reduce(0, +)

        var dxValues = [(dx: Double, plusDI: Double, minusDI: Double)]()

        for i in period..<plusDMList.count {
            smoothedPlus = smoothedPlus - (smoothedPlus / Double(period)) + plusDMList[i]
            smoothedMinus = smoothedMinus - (smoothedMinus / Double(period)) + minusDMList[i]
            smoothedTR = smoothedTR - (smoothedTR / Double(period)) + trList[i]

            guard smoothedTR != 0 else { continue }
            let plusDI = (smoothedPlus / smoothedTR) * 100.0
            let minusDI = (smoothedMinus / smoothedTR) * 100.0
            let diSum = plusDI + minusDI
            let dx = diSum != 0 ? (abs(plusDI - minusDI) / diSum) * 100.0 : 0
            dxValues.append((dx, plusDI, minusDI))
        }

        guard dxValues.count >= period else { return nil }

        var adx = dxValues[..<period].reduce(0.0) { $0 + $1.dx } / Double(period)
        for i in period..<dxValues.count {
            adx = (adx * Double(period - 1) + dxValues[i].dx) / Double(period)
        }

        let adxFinal = adx.rounded(toPlaces: 2)
        let plusDIFinal = dxValues.last!.plusDI.rounded(toPlaces: 2)
        let minusDIFinal = dxValues.last!.minusDI.rounded(toPlaces: 2)

        let strength: String
        if adxFinal < 20 { strength = "Weak/No Trend" }
        else if adxFinal < 40 { strength = "Moderate Trend" }
        else if adxFinal < 60 { strength = "Strong Trend" }
        else { strength = "Very Strong Trend" }

        return ADXResult(
            adx: adxFinal,
            plusDI: plusDIFinal,
            minusDI: minusDIFinal,
            strength: strength,
            direction: plusDIFinal > minusDIFinal ? "Bullish" : "Bearish"
        )
    }
}
