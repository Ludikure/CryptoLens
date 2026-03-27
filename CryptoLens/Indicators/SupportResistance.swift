import Foundation

enum SupportResistance {
    static func find(highs: [Double], lows: [Double], closes: [Double], lookback: Int = 50) -> SRResult {
        var supports = [Double]()
        var resistances = [Double]()

        for i in 2..<min(lookback, highs.count - 2) {
            let idx = highs.count - 1 - i
            guard idx >= 2, idx < highs.count - 2 else { continue }

            // Swing high: higher than 2 neighbors on each side
            if highs[idx] > highs[idx - 1] && highs[idx] > highs[idx - 2]
                && highs[idx] > highs[idx + 1] && highs[idx] >= highs[idx + 2] {
                resistances.append(highs[idx].rounded(toPlaces: 2))
            }

            // Swing low: lower than 2 neighbors on each side
            if lows[idx] < lows[idx - 1] && lows[idx] < lows[idx - 2]
                && lows[idx] < lows[idx + 1] && lows[idx] <= lows[idx + 2] {
                supports.append(lows[idx].rounded(toPlaces: 2))
            }
        }

        let current = closes.last ?? 0
        // Supports below current price, sorted closest first
        let filteredSupports = Array(Set(supports).filter { $0 < current }.sorted(by: >).prefix(5))
        // Resistances above current price, sorted closest first
        let filteredResistances = Array(Set(resistances).filter { $0 > current }.sorted().prefix(5))

        return SRResult(supports: filteredSupports, resistances: filteredResistances)
    }
}
