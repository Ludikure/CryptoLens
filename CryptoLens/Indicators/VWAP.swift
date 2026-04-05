import Foundation

enum VWAP {
    /// Compute VWAP anchored to session.
    /// - Parameter sessionCandles: If provided, only the last N candles are used (session anchor).
    ///   For 1H: 24 (1 day), 4H: 6 (1 day), Daily: 20 (monthly).
    static func compute(highs: [Double], lows: [Double], closes: [Double], volumes: [Double], sessionCandles: Int? = nil) -> VWAPResult? {
        guard !closes.isEmpty, !volumes.isEmpty else { return nil }

        let count = closes.count
        let anchor = min(sessionCandles ?? count, count)
        let startIdx = count - anchor

        var cumVol = 0.0
        var cumTPVol = 0.0
        for i in startIdx..<count {
            let tp = (highs[i] + lows[i] + closes[i]) / 3.0
            cumVol += volumes[i]
            cumTPVol += tp * volumes[i]
        }
        guard cumVol != 0 else { return nil }
        let vwap = cumTPVol / cumVol
        let current = closes.last!
        return VWAPResult(
            vwap: vwap.rounded(toPlaces: 2),
            priceVsVwap: current > vwap ? "above" : "below",
            distancePercent: (((current - vwap) / vwap) * 100).rounded(toPlaces: 2)
        )
    }
}
