import Foundation

enum VWAP {
    static func compute(highs: [Double], lows: [Double], closes: [Double], volumes: [Double]) -> VWAPResult? {
        guard !closes.isEmpty, !volumes.isEmpty else { return nil }
        var cumVol = 0.0
        var cumTPVol = 0.0
        for i in 0..<closes.count {
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
