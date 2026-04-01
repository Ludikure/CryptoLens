import Foundation

/// Volume Profile: POC, Value Area High, Value Area Low
/// Computed from existing candle data — no additional API calls.
struct VolumeProfileResult: Codable {
    let poc: Double
    let valueAreaHigh: Double
    let valueAreaLow: Double
}

enum VolumeProfile {

    /// Compute volume profile with:
    /// - Dynamic body/wick weighting based on candle shape
    /// - Time-weighted decay (recent candles contribute more)
    /// - Gaussian distribution toward typical price
    /// - Forming candle volume scaling
    static func compute(candles: [Candle], atr: Double) -> VolumeProfileResult? {
        guard candles.count >= 10, atr > 0 else { return nil }

        guard let rangeHigh = candles.map(\.high).max(),
              let rangeLow = candles.map(\.low).min() else { return nil }
        let totalRange = rangeHigh - rangeLow
        guard totalRange > 0 else { return nil }

        let bucketSize = atr * 0.25
        let bucketCount = max(10, min(100, Int(ceil(totalRange / bucketSize))))
        let actualBucketSize = totalRange / Double(bucketCount)

        var buckets = [Double](repeating: 0, count: bucketCount)
        let candleCount = candles.count

        for (idx, candle) in candles.enumerated() {
            let bodyTop = max(candle.open, candle.close)
            let bodyBot = min(candle.open, candle.close)
            let bodyRange = bodyTop - bodyBot
            let candleRange = candle.high - candle.low
            guard candleRange > 0 else { continue }

            var vol = candle.volume
            guard vol > 0 else { continue }

            // Scale forming candle (last candle) volume proportionally
            // Assume it's halfway through if it's the newest
            if idx == candleCount - 1 && candleCount > 1 {
                let prevVol = candles[candleCount - 2].volume
                if vol < prevVol * 0.7 { vol = vol * 1.5 }  // Scale up if notably less than prior
            }

            // Time decay: recent candles weighted more (0.97^distance)
            let decayWeight = pow(0.97, Double(candleCount - 1 - idx))
            vol *= decayWeight

            // Dynamic body/wick ratio based on candle shape
            let bodyShare = max(0.5, bodyRange / candleRange)
            let bodyVol = vol * bodyShare
            let wickVol = vol * (1.0 - bodyShare)

            // Typical price for Gaussian centering
            let typicalPrice = (candle.high + candle.low + candle.close) / 3.0

            // Distribute body volume with Gaussian weighting toward typical price
            let bodyStartIdx = bucketIdx(bodyBot, rangeLow: rangeLow, bucketSize: actualBucketSize, count: bucketCount)
            let bodyEndIdx = bucketIdx(bodyTop, rangeLow: rangeLow, bucketSize: actualBucketSize, count: bucketCount)
            distributeGaussian(buckets: &buckets, from: bodyStartIdx, to: bodyEndIdx,
                               volume: bodyVol, center: typicalPrice,
                               rangeLow: rangeLow, bucketSize: actualBucketSize)

            // Distribute wick volume uniformly across full range
            let wickStartIdx = bucketIdx(candle.low, rangeLow: rangeLow, bucketSize: actualBucketSize, count: bucketCount)
            let wickEndIdx = bucketIdx(candle.high, rangeLow: rangeLow, bucketSize: actualBucketSize, count: bucketCount)
            let wickBuckets = max(1, wickEndIdx - wickStartIdx + 1)
            let perWickBucket = wickVol / Double(wickBuckets)
            for i in wickStartIdx...wickEndIdx {
                buckets[i] += perWickBucket
            }
        }

        // POC: bucket with max volume
        guard let maxIdx = buckets.enumerated().max(by: { $0.element < $1.element })?.offset else { return nil }
        let poc = rangeLow + (Double(maxIdx) + 0.5) * actualBucketSize

        // Value Area: expand from POC until 70% of total volume
        let totalVol = buckets.reduce(0, +)
        let targetVol = totalVol * 0.7
        var captured = buckets[maxIdx]
        var low = maxIdx
        var high = maxIdx

        while captured < targetVol && (low > 0 || high < bucketCount - 1) {
            let belowVol = low > 0 ? buckets[low - 1] : 0
            let aboveVol = high < bucketCount - 1 ? buckets[high + 1] : 0

            if belowVol >= aboveVol && low > 0 {
                low -= 1; captured += buckets[low]
            } else if high < bucketCount - 1 {
                high += 1; captured += buckets[high]
            } else if low > 0 {
                low -= 1; captured += buckets[low]
            } else { break }
        }

        let val = rangeLow + Double(low) * actualBucketSize
        let vah = rangeLow + (Double(high) + 1) * actualBucketSize
        return VolumeProfileResult(poc: poc, valueAreaHigh: vah, valueAreaLow: val)
    }

    // MARK: - Gaussian Distribution

    /// Distribute volume across buckets with Gaussian weighting centered on typical price.
    private static func distributeGaussian(buckets: inout [Double], from: Int, to: Int,
                                            volume: Double, center: Double,
                                            rangeLow: Double, bucketSize: Double) {
        guard from <= to else { return }
        let sigma = Double(to - from + 1) * 0.4  // Spread relative to range

        var weights = [Double]()
        var totalWeight = 0.0
        for i in from...to {
            let bucketCenter = rangeLow + (Double(i) + 0.5) * bucketSize
            let dist = (bucketCenter - center) / (sigma * bucketSize)
            let w = exp(-0.5 * dist * dist)
            weights.append(w)
            totalWeight += w
        }

        guard totalWeight > 0 else { return }
        for (offset, i) in (from...to).enumerated() {
            buckets[i] += volume * (weights[offset] / totalWeight)
        }
    }

    // MARK: - Helpers

    private static func bucketIdx(_ price: Double, rangeLow: Double, bucketSize: Double, count: Int) -> Int {
        max(0, min(count - 1, Int((price - rangeLow) / bucketSize)))
    }

    // MARK: - POC Alignment Check

    /// Check if Daily and 4H POCs converge (within 0.5× ATR).
    static func pocAlignment(daily: VolumeProfileResult?, fourH: VolumeProfileResult?, atr: Double) -> String? {
        guard let d = daily, let h = fourH, atr > 0 else { return nil }
        let distance = abs(d.poc - h.poc)
        let ratio = distance / atr
        if ratio < 0.5 {
            let avg = (d.poc + h.poc) / 2
            return "Daily/4H converged at \(formatP(avg)) (within \(String(format: "%.1f", ratio))× ATR)"
        } else {
            return "Divergent (D: \(formatP(d.poc)), 4H: \(formatP(h.poc)))"
        }
    }

    // MARK: - Naked POC Tracking

    /// Store today's daily POC for a symbol. Called after computing daily volume profile.
    static func storePOC(_ poc: Double, symbol: String) {
        let key = "nakedPOC:\(symbol)"
        let today = Calendar.current.startOfDay(for: Date())
        let stored: [String: Any] = ["poc": poc, "date": today.timeIntervalSince1970]
        UserDefaults.standard.set(stored, forKey: key)
    }

    /// Get previous session's POC if price hasn't traded through it (naked).
    static func nakedPOC(symbol: String, currentLow: Double, currentHigh: Double) -> (price: Double, date: String)? {
        let key = "nakedPOC:\(symbol)"
        guard let stored = UserDefaults.standard.dictionary(forKey: key),
              let poc = stored["poc"] as? Double,
              let dateTs = stored["date"] as? Double else { return nil }

        let storedDate = Date(timeIntervalSince1970: dateTs)
        let today = Calendar.current.startOfDay(for: Date())

        // Only report if POC is from a previous day
        guard storedDate < today else { return nil }

        // Check if price has traded through it today
        if currentLow <= poc && currentHigh >= poc {
            return nil  // POC was tested — no longer naked
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return (poc, formatter.string(from: storedDate))
    }

    private static func formatP(_ price: Double) -> String {
        if price >= 1 { return String(format: "$%.2f", price) }
        else { return String(format: "$%.4f", price) }
    }
}
