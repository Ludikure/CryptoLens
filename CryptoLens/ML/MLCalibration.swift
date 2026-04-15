import Foundation

/// Isotonic calibration mapping for ML probability outputs.
/// Maps raw XGBoost/CoreML probabilities to actual observed win rates.
enum MLCalibration {
    private static let cryptoMap: (x: [Double], y: [Double])? = {
        guard let url = Bundle.main.url(forResource: "crypto_calibration", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: [Double]],
              let x = json["x"], let y = json["y"], x.count == y.count, x.count >= 2
        else { return nil }
        return (x, y)
    }()

    private static let stockMap: (x: [Double], y: [Double])? = {
        guard let url = Bundle.main.url(forResource: "stock_calibration", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: [Double]],
              let x = json["x"], let y = json["y"], x.count == y.count, x.count >= 2
        else { return nil }
        return (x, y)
    }()

    /// Apply isotonic calibration via linear interpolation between breakpoints.
    static func calibrate(_ rawProb: Double, isCrypto: Bool) -> Double {
        guard let map = isCrypto ? cryptoMap : stockMap else { return rawProb }
        let x = map.x, y = map.y

        if rawProb <= x[0] { return y[0] }
        if rawProb >= x[x.count - 1] { return y[y.count - 1] }

        // Binary search for bracket
        var lo = 0, hi = x.count - 1
        while lo < hi - 1 {
            let mid = (lo + hi) / 2
            if x[mid] <= rawProb { lo = mid } else { hi = mid }
        }

        // Linear interpolation, capped at 85% (model accuracy is ~65%, no higher claims)
        let t = (rawProb - x[lo]) / (x[hi] - x[lo])
        return max(0, min(0.85, y[lo] + t * (y[hi] - y[lo])))
    }
}
