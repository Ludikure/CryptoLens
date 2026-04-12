import Foundation

/// Fetches historical derivatives data from Binance Futures for backtesting.
/// All endpoints are free, no API key, and go back to 2020 for BTCUSDT.
enum HistoricalDerivativesService {

    private static let baseURL = "https://fapi.binance.com"

    struct DerivativesBar: Codable {
        let timestamp: Date
        let fundingRate: Double?
        let openInterest: Double?
        let longPercent: Double?
        let shortPercent: Double?
        let takerBuySellRatio: Double?
    }

    /// Fetch all derivatives time series for a symbol, aligned to 4H bars.
    static func fetch(symbol: String, startDate: Date, endDate: Date) async -> [Date: DerivativesBar] {
        async let funding = fetchFundingHistory(symbol: symbol, startDate: startDate, endDate: endDate)
        async let oi = fetchOIHistory(symbol: symbol, startDate: startDate, endDate: endDate)
        async let ls = fetchLongShortHistory(symbol: symbol, startDate: startDate, endDate: endDate)
        async let taker = fetchTakerHistory(symbol: symbol, startDate: startDate, endDate: endDate)

        let (fundingData, oiData, lsData, takerData) = await (funding, oi, ls, taker)

        // Merge all series by timestamp (round to nearest 4H)
        var merged = [Date: DerivativesBar]()

        for (ts, fr) in fundingData {
            let key = round4H(ts)
            let existing = merged[key]
            merged[key] = DerivativesBar(timestamp: key, fundingRate: fr,
                openInterest: existing?.openInterest, longPercent: existing?.longPercent,
                shortPercent: existing?.shortPercent, takerBuySellRatio: existing?.takerBuySellRatio)
        }

        for (ts, val) in oiData {
            let key = round4H(ts)
            let existing = merged[key]
            merged[key] = DerivativesBar(timestamp: key, fundingRate: existing?.fundingRate,
                openInterest: val, longPercent: existing?.longPercent,
                shortPercent: existing?.shortPercent, takerBuySellRatio: existing?.takerBuySellRatio)
        }

        for (ts, longPct) in lsData {
            let key = round4H(ts)
            let existing = merged[key]
            merged[key] = DerivativesBar(timestamp: key, fundingRate: existing?.fundingRate,
                openInterest: existing?.openInterest, longPercent: longPct,
                shortPercent: 100 - longPct, takerBuySellRatio: existing?.takerBuySellRatio)
        }

        for (ts, ratio) in takerData {
            let key = round4H(ts)
            let existing = merged[key]
            merged[key] = DerivativesBar(timestamp: key, fundingRate: existing?.fundingRate,
                openInterest: existing?.openInterest, longPercent: existing?.longPercent,
                shortPercent: existing?.shortPercent, takerBuySellRatio: ratio)
        }

        return merged
    }

    /// Round a date to the nearest 4H boundary (public for use by optimizer).
    static func round4H(_ date: Date) -> Date {
        let interval: TimeInterval = 4 * 3600
        return Date(timeIntervalSince1970: floor(date.timeIntervalSince1970 / interval) * interval)
    }

    // MARK: - Individual Endpoints

    /// /fapi/v1/fundingRate - 8-hourly, paginated (max 1000 per request)
    private static func fetchFundingHistory(symbol: String, startDate: Date, endDate: Date) async -> [(Date, Double)] {
        var results = [(Date, Double)]()
        var cursor = startDate

        while cursor < endDate {
            let startMs = Int(cursor.timeIntervalSince1970 * 1000)
            let endMs = Int(endDate.timeIntervalSince1970 * 1000)
            let url = "\(baseURL)/fapi/v1/fundingRate?symbol=\(symbol)&startTime=\(startMs)&endTime=\(endMs)&limit=1000"

            guard let data = try? await fetchJSON(url) as? [[String: Any]] else {
                cursor = cursor.addingTimeInterval(1000 * 8 * 3600)
                continue
            }

            if data.isEmpty { break }

            var lastTs: Int64 = 0
            for entry in data {
                guard let tsNum = entry["fundingTime"] as? NSNumber,
                      let rateStr = entry["fundingRate"] as? String,
                      let rate = Double(rateStr) else { continue }
                let ts = tsNum.int64Value
                lastTs = max(lastTs, ts)
                results.append((Date(timeIntervalSince1970: Double(ts) / 1000), rate * 100))
            }

            // Advance cursor past last returned entry
            cursor = Date(timeIntervalSince1970: Double(lastTs) / 1000 + 1)
            if data.count < 1000 { break } // truly exhausted
            try? await Task.sleep(nanoseconds: 200_000_000)
        }

        return results
    }

    /// /futures/data/openInterestHist - 4H periods
    private static func fetchOIHistory(symbol: String, startDate: Date, endDate: Date) async -> [(Date, Double)] {
        return await fetchTimeSeries(
            endpoint: "/futures/data/openInterestHist",
            symbol: symbol, period: "4h",
            startDate: startDate, endDate: endDate,
            valueKey: "sumOpenInterest"
        )
    }

    /// /futures/data/globalLongShortAccountRatio - 4H periods
    private static func fetchLongShortHistory(symbol: String, startDate: Date, endDate: Date) async -> [(Date, Double)] {
        let raw = await fetchTimeSeries(
            endpoint: "/futures/data/globalLongShortAccountRatio",
            symbol: symbol, period: "4h",
            startDate: startDate, endDate: endDate,
            valueKey: "longAccount"
        )
        return raw.map { ($0.0, $0.1 * 100) }  // decimal → percent
    }

    /// /futures/data/takerlongshortRatio - 4H periods
    private static func fetchTakerHistory(symbol: String, startDate: Date, endDate: Date) async -> [(Date, Double)] {
        return await fetchTimeSeries(
            endpoint: "/futures/data/takerlongshortRatio",
            symbol: symbol, period: "4h",
            startDate: startDate, endDate: endDate,
            valueKey: "buySellRatio"
        )
    }

    /// Generic paginated fetcher for Binance futures data endpoints.
    /// Note: OI, long/short, and taker endpoints may only return ~30 days of history.
    private static func fetchTimeSeries(endpoint: String, symbol: String, period: String,
                                         startDate: Date, endDate: Date,
                                         valueKey: String) async -> [(Date, Double)] {
        var results = [(Date, Double)]()
        var cursor = startDate

        while cursor < endDate {
            let startMs = Int(cursor.timeIntervalSince1970 * 1000)
            let endMs = Int(endDate.timeIntervalSince1970 * 1000)
            let url = "\(baseURL)\(endpoint)?symbol=\(symbol)&period=\(period)&startTime=\(startMs)&endTime=\(endMs)&limit=500"

            guard let data = try? await fetchJSON(url) as? [[String: Any]] else {
                cursor = cursor.addingTimeInterval(500 * 4 * 3600)
                continue
            }

            if data.isEmpty { break }

            var lastTs: Int64 = 0
            for entry in data {
                guard let tsNum = entry["timestamp"] as? NSNumber else { continue }
                let ts = tsNum.int64Value
                lastTs = max(lastTs, ts)
                let value: Double
                if let str = entry[valueKey] as? String, let v = Double(str) { value = v }
                else if let v = entry[valueKey] as? Double { value = v }
                else { continue }
                results.append((Date(timeIntervalSince1970: Double(ts) / 1000), value))
            }

            cursor = Date(timeIntervalSince1970: Double(lastTs) / 1000 + 1)
            if data.count < 500 { break }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }

        return results
    }

    // MARK: - Helpers

    private static func fetchJSON(_ urlString: String) async throws -> Any {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONSerialization.jsonObject(with: data)
    }
}
