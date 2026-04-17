import Foundation

/// Stock earnings calendar — bundled JSON of historical + upcoming earnings dates per symbol.
/// Used for ML features (daysToEarnings, daysSinceEarnings, isEarningsWeek).
/// Regenerate via: python3 ml-training/earnings_backfill.py (writes ml-training/earnings_history.json,
/// then copy to CryptoLens/Resources/earnings_history.json before building).
enum EarningsCalendar {
    /// symbol → sorted list of earnings dates (Date at 00:00 UTC, parsed from YYYY-MM-DD strings)
    private static let calendar: [String: [Date]] = {
        guard let url = Bundle.main.url(forResource: "earnings_history", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String]]
        else { return [:] }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = TimeZone(identifier: "UTC")
        var out: [String: [Date]] = [:]
        for (sym, strs) in json {
            let dates = strs.compactMap(fmt.date(from:)).sorted()
            out[sym] = dates
        }
        return out
    }()

    /// Returns (daysToEarnings, daysSinceEarnings, isEarningsWeek) for a symbol at a given time.
    /// daysToEarnings/daysSinceEarnings are capped at 60 (meaning "far out or unknown").
    /// For ETFs, crypto, or symbols with no earnings data, returns (60, 60, false).
    static func features(for symbol: String, at bar: Date) -> (daysTo: Int, daysSince: Int, isWeek: Bool) {
        let dates = calendar[symbol] ?? []
        if dates.isEmpty { return (60, 60, false) }

        // Find the first earnings date on or after `bar`
        let next = dates.first(where: { $0 >= bar })
        let prev = dates.last(where: { $0 < bar })

        let daysTo: Int = {
            guard let next else { return 60 }
            let secs = next.timeIntervalSince(bar)
            return min(60, max(0, Int(secs / 86400)))
        }()
        let daysSince: Int = {
            guard let prev else { return 60 }
            let secs = bar.timeIntervalSince(prev)
            return min(60, max(0, Int(secs / 86400)))
        }()
        let isWeek = daysTo <= 7 || daysSince <= 7
        return (daysTo, daysSince, isWeek)
    }
}
