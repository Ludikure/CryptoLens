import Foundation

/// Loads historical FINRA RegSHO dark pool data for backtesting.
/// Data source: ml-training/finra_dark_pool.py → dark_pool_history.json (bundled).
enum DarkPoolData {
    private static let data: [String: [(date: String, ratio: Double, zscore: Double)]] = {
        guard let url = Bundle.main.url(forResource: "dark_pool_history", withExtension: "json"),
              let raw = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: raw) as? [String: [[String: Any]]]
        else { return [:] }
        var out: [String: [(String, Double, Double)]] = [:]
        for (sym, entries) in json {
            out[sym] = entries.compactMap { e in
                guard let d = e["date"] as? String,
                      let r = e["ratio"] as? Double,
                      let z = e["zscore"] as? Double else { return nil }
                return (d, r, z)
            }
        }
        return out
    }()

    static func features(for symbol: String, at bar: Date) -> (ratio: Double, zscore: Double) {
        let entries = data[symbol] ?? []
        if entries.isEmpty { return (0.5, 0) }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = TimeZone(identifier: "UTC")
        let target = fmt.string(from: bar)
        // Find the most recent entry on or before target date
        var best: (Double, Double) = (0.5, 0)
        for e in entries {
            if e.date <= target { best = (e.ratio, e.zscore) }
            else { break }
        }
        return best
    }
}
