import Foundation

enum SupportResistance {
    /// Cluster nearby levels within tolerance, averaging them together.
    static func clusterLevels(_ levels: [Double], tolerance: Double) -> [Double] {
        var clustered = [Double]()
        let sorted = levels.sorted()
        for level in sorted {
            if let last = clustered.last, abs(level - last) < tolerance {
                clustered[clustered.count - 1] = (last + level) / 2.0
            } else {
                clustered.append(level)
            }
        }
        return clustered
    }

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

        // Compute clustering tolerance from price range (~0.3% of range)
        let highMax = highs.max() ?? 0
        let lowMin = lows.min() ?? 0
        let tolerance = (highMax - lowMin) * 0.003

        // Cluster nearby levels, then filter and sort
        let clusteredSupports = clusterLevels(supports, tolerance: tolerance)
        let clusteredResistances = clusterLevels(resistances, tolerance: tolerance)

        // Supports below current price, sorted closest first
        let filteredSupports = Array(clusteredSupports.filter { $0 < current }.sorted(by: >).prefix(5))
        // Resistances above current price, sorted closest first
        let filteredResistances = Array(clusteredResistances.filter { $0 > current }.sorted().prefix(5))

        return SRResult(supports: filteredSupports, resistances: filteredResistances)
    }
}
