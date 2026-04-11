import Foundation

/// Fetches stock fundamental/contextual data from Finnhub via the worker proxy.
/// Supplements Yahoo Finance with analyst recs, metrics, earnings, and news.
class FinnhubProvider {
    private let session = URLSession.shared
    private let workerURL = PushService.workerURL

    // MARK: - Analyst Recommendations

    struct Recommendation {
        let buy: Int
        let hold: Int
        let sell: Int
        let strongBuy: Int
        let strongSell: Int
        let period: String
    }

    func fetchRecommendations(symbol: String) async -> Recommendation? {
        guard let data = await fetchEndpoint("recommendation", symbol: symbol) else { return nil }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let latest = arr.first else { return nil }

        return Recommendation(
            buy: latest["buy"] as? Int ?? 0,
            hold: latest["hold"] as? Int ?? 0,
            sell: latest["sell"] as? Int ?? 0,
            strongBuy: latest["strongBuy"] as? Int ?? 0,
            strongSell: latest["strongSell"] as? Int ?? 0,
            period: latest["period"] as? String ?? ""
        )
    }

    // MARK: - Basic Metrics (P/E, EPS, 52w, short interest)

    struct StockMetrics {
        let peRatio: Double?
        let eps: Double?
        let high52w: Double?
        let low52w: Double?
        let marketCap: Double?
        let dividendYield: Double?
        let shortPercentOfFloat: Double?
        let beta: Double?
        let revenueGrowthTTM: Double?
    }

    func fetchMetrics(symbol: String) async -> StockMetrics? {
        guard let data = await fetchEndpoint("metric", symbol: symbol) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let m = json["metric"] as? [String: Any] else { return nil }

        return StockMetrics(
            peRatio: m["peBasicExclExtraTTM"] as? Double,
            eps: m["epsBasicExclExtraItemsTTM"] as? Double,
            high52w: m["52WeekHigh"] as? Double,
            low52w: m["52WeekLow"] as? Double,
            marketCap: m["marketCapitalization"] as? Double,
            dividendYield: m["dividendYieldIndicatedAnnual"] as? Double,
            shortPercentOfFloat: m["shortPercentOutstanding"] as? Double,
            beta: m["beta"] as? Double,
            revenueGrowthTTM: m["revenueGrowthTTM5Y"] as? Double
        )
    }

    // MARK: - Earnings Calendar

    struct EarningsInfo {
        let date: Date?
        let epsEstimate: Double?
        let revenueEstimate: Double?
        let quarter: Int?
        let year: Int?
    }

    func fetchEarnings(symbol: String) async -> EarningsInfo? {
        guard let data = await fetchEndpoint("earnings", symbol: symbol) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calendar = json["earningsCalendar"] as? [[String: Any]] else { return nil }

        // Find the next upcoming or most recent for this symbol
        let matching = calendar.filter { ($0["symbol"] as? String) == symbol }
        guard let entry = matching.first else { return nil }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")

        return EarningsInfo(
            date: (entry["date"] as? String).flatMap { formatter.date(from: $0) },
            epsEstimate: entry["epsEstimate"] as? Double,
            revenueEstimate: entry["revenueEstimate"] as? Double,
            quarter: entry["quarter"] as? Int,
            year: entry["year"] as? Int
        )
    }

    // MARK: - Insider Transactions

    struct InsiderTransaction {
        let name: String
        let title: String       // "CEO", "CFO", "Director", etc.
        let date: Date
        let shares: Int         // positive = buy, negative = sell
        let value: Double       // USD value of transaction
        let isBuy: Bool
    }

    func fetchInsiderTransactions(symbol: String) async -> [InsiderTransaction] {
        guard let data = await fetchEndpoint("insider", symbol: symbol) else { return [] }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let txArray = json["data"] as? [[String: Any]]
        else { return [] }

        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.locale = Locale(identifier: "en_US_POSIX")

        let threeMonthsAgo = Date().addingTimeInterval(-90 * 86400)
        var results = [InsiderTransaction]()

        for tx in txArray {
            guard let name = tx["name"] as? String,
                  let dateStr = tx["transactionDate"] as? String,
                  let date = df.date(from: dateStr),
                  date >= threeMonthsAgo
            else { continue }

            // `change` = shares traded (positive=buy, negative=sell)
            // `share` = total shares held AFTER transaction (not what we want)
            let change = tx["change"] as? Int ?? 0
            let price = tx["transactionPrice"] as? Double ?? 0
            let code = tx["transactionCode"] as? String ?? ""

            // P = purchase, S = sale. Skip A (grant/award), M (exercise), etc.
            guard code == "P" || code == "S" else { continue }
            guard change != 0 else { continue }

            let isBuy = code == "P"
            let shareCount = abs(change)
            let title = (tx["filingType"] as? String) ?? ""

            results.append(InsiderTransaction(
                name: name,
                title: title,
                date: date,
                shares: isBuy ? shareCount : -shareCount,
                value: Double(shareCount) * price,
                isBuy: isBuy
            ))
        }

        return results.sorted { $0.date > $1.date } // newest first
    }

    // MARK: - Company News (top headlines)

    func fetchNews(symbol: String, limit: Int = 5) async -> [String] {
        guard let data = await fetchEndpoint("news", symbol: symbol) else { return [] }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }

        return arr.prefix(limit).compactMap { $0["headline"] as? String }
    }

    // MARK: - Generic Worker Fetch

    private func fetchEndpoint(_ endpoint: String, symbol: String) async -> Data? {
        await PushService.ensureAuth()
        guard let url = URL(string: "\(workerURL)/finnhub/\(endpoint)?symbol=\(symbol)") else { return nil }
        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode)
        else {
            await MainActor.run { ConnectionStatus.shared.finnhub = .error }
            return nil
        }

        await MainActor.run { ConnectionStatus.shared.finnhub = .ok }
        return data
    }
}
