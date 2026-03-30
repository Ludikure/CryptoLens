import Foundation

struct MacroSnapshot: Codable {
    let dxy: Double?
    let dxyChange: Double?
    let dollarTrend: String?
    let treasury10Y: Double?
    let treasury2Y: Double?
    let yieldSpread: Double?
    let timestamp: Date
}

@MainActor
class MacroDataService {
    private let session = URLSession.shared
    private let workerURL = PushService.workerURL

    private var cachedSnapshot: MacroSnapshot?
    private var lastFetch: Date?
    private let cacheInterval: TimeInterval = 300

    func fetchMacroSnapshot() async -> MacroSnapshot? {
        if let cached = cachedSnapshot, let last = lastFetch, Date().timeIntervalSince(last) < cacheInterval {
            return cached
        }

        // Fetch from worker (server caches and proxies both Twelve Data + Yahoo)
        guard let url = URL(string: "\(workerURL)/macro") else { return nil }

        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

            let eurusd = json["eurusd"] as? Double
            let eurusdChange = json["eurusdChange"] as? Double
            let t10y = json["treasury10Y"] as? Double
            let t2y = json["treasury2Y"] as? Double

            let dollarTrend: String?
            if let change = eurusdChange {
                if change > 0.2 { dollarTrend = "Weakening" }
                else if change < -0.2 { dollarTrend = "Strengthening" }
                else { dollarTrend = "Flat" }
            } else {
                dollarTrend = nil
            }

            let spread: Double? = if let t10 = t10y, let t2 = t2y { t10 - t2 } else { nil }

            let snapshot = MacroSnapshot(
                dxy: eurusd,
                dxyChange: eurusdChange.map { -$0 },
                dollarTrend: dollarTrend,
                treasury10Y: t10y,
                treasury2Y: t2y,
                yieldSpread: spread,
                timestamp: Date()
            )

            cachedSnapshot = snapshot
            lastFetch = Date()

            #if DEBUG
            print("[MarketScope] Macro: EUR/USD=\(eurusd ?? 0), USD \(dollarTrend ?? "?"), 10Y=\(t10y ?? 0)%, 2Y=\(t2y ?? 0)%")
            #endif

            return snapshot
        } catch {
            #if DEBUG
            print("[MarketScope] Macro fetch error: \(error)")
            #endif
            return nil
        }
    }
}
