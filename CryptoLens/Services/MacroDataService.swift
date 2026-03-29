import Foundation

struct MacroSnapshot: Codable {
    let dxy: Double?           // USD strength (derived from EUR/USD inverse)
    let dxyChange: Double?     // % change
    let dollarTrend: String?   // "Strengthening", "Weakening", "Flat"
    let treasury10Y: Double?   // 10-Year yield %
    let treasury2Y: Double?    // 2-Year yield %
    let yieldSpread: Double?   // 10Y - 2Y (negative = inverted)
    let timestamp: Date
}

@MainActor
class MacroDataService {
    private let session = URLSession.shared
    private let twelveDataBase = "https://api.twelvedata.com"
    private var twelveDataKey: String { Bundle.main.infoDictionary?["TwelveDataAPIKey"] as? String ?? "" }

    private var cachedSnapshot: MacroSnapshot?
    private var lastFetch: Date?
    private let cacheInterval: TimeInterval = 300 // 5 min

    func fetchMacroSnapshot() async -> MacroSnapshot? {
        if let cached = cachedSnapshot, let last = lastFetch, Date().timeIntervalSince(last) < cacheInterval {
            return cached
        }

        // Fetch EUR/USD from Twelve Data (dollar direction)
        let eurusd = await fetchTwelveDataQuote(symbol: "EUR/USD")

        // Fetch treasury yields from Yahoo Finance (^TNX = 10Y, ^IRX = 13-week T-bill as 2Y proxy)
        let t10y = await fetchYahooIndex(symbol: "%5ETNX")  // ^TNX
        let t2y = await fetchYahooIndex(symbol: "%5EIRX")   // ^IRX (short-term rate proxy)

        // Derive DXY-like value from EUR/USD (inverse relationship)
        let dxy: Double? = eurusd?.close
        let dxyChange: Double? = eurusd?.percentChange
        // EUR/USD up = dollar weakening, so invert the direction
        let dollarTrend: String?
        if let change = dxyChange {
            if change > 0.2 { dollarTrend = "Weakening" }       // EUR up = USD down
            else if change < -0.2 { dollarTrend = "Strengthening" } // EUR down = USD up
            else { dollarTrend = "Flat" }
        } else {
            dollarTrend = nil
        }

        let spread: Double? = if let t10 = t10y, let t2 = t2y { t10 - t2 } else { nil }

        let snapshot = MacroSnapshot(
            dxy: dxy,
            dxyChange: dxyChange.map { -$0 },  // Invert: EUR/USD change → USD change
            dollarTrend: dollarTrend,
            treasury10Y: t10y,
            treasury2Y: t2y,
            yieldSpread: spread,
            timestamp: Date()
        )

        cachedSnapshot = snapshot
        lastFetch = Date()

        #if DEBUG
        print("[MarketScope] Macro: EUR/USD=\(dxy ?? 0) (\(dxyChange ?? 0)%), USD \(dollarTrend ?? "?"), 10Y=\(t10y ?? 0)%, 2Y=\(t2y ?? 0)%")
        #endif

        return snapshot
    }

    // MARK: - Twelve Data

    private struct QuoteResult {
        let close: Double
        let percentChange: Double
    }

    private func fetchTwelveDataQuote(symbol: String) async -> QuoteResult? {
        guard !twelveDataKey.isEmpty, twelveDataKey != "your-twelve-data-key-here" else { return nil }
        guard let url = URL(string: "\(twelveDataBase)/quote?symbol=\(symbol)&apikey=\(twelveDataKey)") else { return nil }

        do {
            let (data, _) = try await session.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["code"] == nil else { return nil }  // Error response has "code" field

            let close = parseDouble(json["close"])
            let pctChange = parseDouble(json["percent_change"])

            guard let c = close else { return nil }
            return QuoteResult(close: c, percentChange: pctChange ?? 0)
        } catch {
            #if DEBUG
            print("[MarketScope] Twelve Data error: \(error)")
            #endif
            return nil
        }
    }

    // MARK: - Yahoo Finance (for indices)

    private func fetchYahooIndex(symbol: String) async -> Double? {
        guard let url = URL(string: "https://query1.finance.yahoo.com/v8/finance/chart/\(symbol)?interval=1d&range=2d") else { return nil }

        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let chart = json["chart"] as? [String: Any],
                  let results = chart["result"] as? [[String: Any]],
                  let result = results.first,
                  let meta = result["meta"] as? [String: Any] else { return nil }

            return (meta["regularMarketPrice"] as? NSNumber)?.doubleValue
        } catch {
            return nil
        }
    }

    private func parseDouble(_ value: Any?) -> Double? {
        if let s = value as? String { return Double(s) }
        if let n = value as? NSNumber { return n.doubleValue }
        return nil
    }
}
