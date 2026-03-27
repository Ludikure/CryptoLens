import Foundation

enum RSIDivergence {
    /// Detect bullish/bearish RSI divergence.
    /// Returns "bullish_divergence", "bearish_divergence", or nil.
    static func detect(closes: [Double], rsiValues: [Double], lookback: Int = 20) -> String? {
        guard closes.count >= lookback, rsiValues.count >= lookback else { return nil }
        let rc = Array(closes.suffix(lookback))
        let rr = Array(rsiValues.suffix(lookback))

        var priceLows = [Double]()
        var rsiAtLows = [Double]()
        var priceHighs = [Double]()
        var rsiAtHighs = [Double]()

        for i in 2..<(rc.count - 2) {
            if rc[i] < rc[i-1] && rc[i] < rc[i-2] && rc[i] < rc[i+1] && rc[i] < rc[i+2] {
                priceLows.append(rc[i])
                rsiAtLows.append(rr[i])
            }
            if rc[i] > rc[i-1] && rc[i] > rc[i-2] && rc[i] > rc[i+1] && rc[i] > rc[i+2] {
                priceHighs.append(rc[i])
                rsiAtHighs.append(rr[i])
            }
        }

        // Bullish: price makes lower low, RSI makes higher low
        if priceLows.count >= 2
            && priceLows[priceLows.count - 1] < priceLows[priceLows.count - 2]
            && rsiAtLows[rsiAtLows.count - 1] > rsiAtLows[rsiAtLows.count - 2] {
            return "bullish_divergence"
        }
        // Bearish: price makes higher high, RSI makes lower high
        if priceHighs.count >= 2
            && priceHighs[priceHighs.count - 1] > priceHighs[priceHighs.count - 2]
            && rsiAtHighs[rsiAtHighs.count - 1] < rsiAtHighs[rsiAtHighs.count - 2] {
            return "bearish_divergence"
        }
        return nil
    }
}
