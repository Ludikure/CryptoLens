import Foundation

/// Aggregates 1H candles into 4H candles for stocks.
/// US market: 9:30-16:00 ET = 6.5 hours → two 4H blocks per day (4H + 2.5H).
enum CandleAggregator {

    static func aggregate1HTo4H(_ hourly: [Candle]) -> [Candle] {
        let cal = Calendar(identifier: .gregorian)
        guard let et = TimeZone(identifier: "America/New_York") else { return [] }

        // Group by trading day
        var dayGroups: [[Candle]] = []
        var currentDay: Int? = nil
        var currentGroup: [Candle] = []

        for candle in hourly {
            let comps = cal.dateComponents(in: et, from: candle.time)
            let day = comps.day
            if day != currentDay {
                if !currentGroup.isEmpty { dayGroups.append(currentGroup) }
                currentGroup = [candle]
                currentDay = day
            } else {
                currentGroup.append(candle)
            }
        }
        if !currentGroup.isEmpty { dayGroups.append(currentGroup) }

        // Chunk each day into 4-candle blocks
        var result: [Candle] = []
        for session in dayGroups {
            var i = 0
            while i < session.count {
                let chunk = Array(session[i..<min(i + 4, session.count)])
                if let merged = mergeCandles(chunk) {
                    result.append(merged)
                }
                i += 4
            }
        }
        return result
    }

    static func mergeCandles(_ candles: [Candle]) -> Candle? {
        guard let first = candles.first, let last = candles.last,
              let high = candles.map(\.high).max(),
              let low = candles.map(\.low).min()
        else { return nil }

        return Candle(
            time: first.time,
            open: first.open,
            high: high,
            low: low,
            close: last.close,
            volume: candles.map(\.volume).reduce(0, +)
        )
    }
}
