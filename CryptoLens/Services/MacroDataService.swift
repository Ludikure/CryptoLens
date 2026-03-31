import Foundation

struct MacroSnapshot: Codable {
    let vix: Double?
    let vixDate: String?
    let treasury10Y: Double?
    let treasury2Y: Double?
    let yieldSpread: Double?
    let fedFundsRate: Double?
    let usdIndex: Double?
    let macroRegime: String?
    let timestamp: Date

    // Legacy compat
    var dxy: Double? { usdIndex }
    var dxyChange: Double? { nil }
    var dollarTrend: String? {
        guard usdIndex != nil else { return nil }
        return "See USD Index"
    }
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

        guard let url = URL(string: "\(workerURL)/macro") else { return nil }

        do {
            let (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

            let vix = json["vix"] as? Double
            let t10y = json["treasury10Y"] as? Double
            let t2y = json["treasury2Y"] as? Double
            let spread = json["yieldSpread"] as? Double
            let fedFunds = json["fedFundsRate"] as? Double
            let usdIdx = json["usdIndex"] as? Double

            // Macro regime classification
            let regime = classifyRegime(vix: vix, spread: spread)

            let snapshot = MacroSnapshot(
                vix: vix,
                vixDate: json["vixDate"] as? String,
                treasury10Y: t10y,
                treasury2Y: t2y,
                yieldSpread: spread,
                fedFundsRate: fedFunds,
                usdIndex: usdIdx,
                macroRegime: regime,
                timestamp: Date()
            )

            cachedSnapshot = snapshot
            lastFetch = Date()
            ConnectionStatus.shared.macro = .ok

            #if DEBUG
            print("[MarketScope] Macro: VIX=\(vix ?? 0), 10Y=\(t10y ?? 0)%, 2Y=\(t2y ?? 0)%, USD=\(usdIdx ?? 0), Regime=\(regime ?? "?")")
            #endif

            return snapshot
        } catch {
            ConnectionStatus.shared.macro = .error
            return nil
        }
    }

    private func classifyRegime(vix: Double?, spread: Double?) -> String? {
        guard let v = vix else { return nil }
        let inverted = (spread ?? 1) < 0

        if v > 35 { return "Crisis" }
        if v > 25 { return "Elevated Fear" }
        if v > 15 && inverted { return "Cautious" }
        if v > 15 { return "Normal" }
        if !inverted { return "Risk-On" }
        return "Normal"
    }
}
