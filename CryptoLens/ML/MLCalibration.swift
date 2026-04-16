import Foundation

/// Isotonic calibration for v9 ML outputs. Two maps (crypto / stock) loaded from bundle.
/// Maps raw XGBoost probability to empirical win rate, capped at 0.85 (validation ceiling).
enum MLCalibration {
    private static let cryptoMap = loadMap("crypto_calibration")
    private static let stockMap  = loadMap("stock_calibration")

    private static func loadMap(_ resource: String) -> (x: [Double], y: [Double])? {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let x = json["x"] as? [Double], let y = json["y"] as? [Double],
              x.count == y.count, x.count >= 2
        else { return nil }
        return (x, y)
    }

    static func calibrate(_ rawProb: Double, isCrypto: Bool) -> Double {
        guard let map = isCrypto ? cryptoMap : stockMap else { return rawProb }
        let x = map.x, y = map.y
        if rawProb <= x[0] { return y[0] }
        if rawProb >= x[x.count - 1] { return y[y.count - 1] }
        var lo = 0, hi = x.count - 1
        while lo < hi - 1 {
            let mid = (lo + hi) / 2
            if x[mid] <= rawProb { lo = mid } else { hi = mid }
        }
        let t = (rawProb - x[lo]) / (x[hi] - x[lo])
        return max(0, min(0.85, y[lo] + t * (y[hi] - y[lo])))
    }
}
