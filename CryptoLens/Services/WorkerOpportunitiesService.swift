import Foundation

/// Reads the ranked opportunity book from the worker's `/opportunities` endpoint.
///
/// Best-effort by design: any failure returns nil and the caller hides the card rather than
/// surfacing an error. This is a secondary read, not something the app depends on.
enum WorkerOpportunitiesService {

    struct Opportunity: Decodable, Identifiable {
        let asset: String
        let direction: String
        let directionAgnostic: Bool
        let entry: Double
        let stop: Double
        let target: Double
        let expectedValueR: Double
        let payoffAsymmetry: Double
        let winProbability: Double
        let score: Double
        let riskFraction: Double
        let notionalFraction: Double
        let positionUsd: Double
        let crashMultiplier: Double
        let bindingConstraints: [String]

        var id: String { "\(asset)-\(direction)" }

        /// Risk per unit as a fraction of entry — what the stop actually costs if hit.
        var stopDistancePercent: Double {
            guard entry > 0 else { return 0 }
            return abs(entry - stop) / entry * 100
        }
    }

    struct Totals: Decodable {
        let riskFraction: Double
        let notionalFraction: Double
        let positions: Int
        /// Correlation-weighted: what the book is really worth as ONE bet. Crypto ρ̄ ≈ 0.62, so
        /// five positions are worth about 1.5 independent bets — the number worth showing.
        let effectiveBets: Double
    }

    struct ModelInfo: Decodable {
        let version: String
        let primaryR: Double
        let features: Int
        let longAuc: Double
        let shortAuc: Double
    }

    /// Drawdown-risk warning. Arrives independently of whether any trade was produced — the day
    /// nothing is tradeable is precisely the day this matters most.
    struct CrashWarning: Decodable, Identifiable {
        let asset: String
        let level: String
        let message: String
        let probability: Double
        var id: String { asset }
        var isHigh: Bool { level == "HIGH" }
    }

    struct CrashModelInfo: Decodable {
        let version: String
        let horizonDays: Int
        let baseRate: Double
        let walkForwardAuc: [Double]
    }

    struct Skipped: Decodable {
        let asset: String
        let reasons: [String]
    }

    struct Book: Decodable {
        let at: Double
        let caveat: String
        let model: ModelInfo?
        let equity: Double
        let opportunities: [Opportunity]
        let totals: Totals
        let skipped: [Skipped]
        let crashWarnings: [CrashWarning]?
        let crashModel: CrashModelInfo?
    }

    /// Fetch the book. `symbols` empty means the worker's default set.
    static func fetch(symbols: [String], equity: Double) async -> Book? {
        var comps = URLComponents(string: "\(PushService.workerURL)/opportunities")
        var items = [URLQueryItem(name: "equity", value: String(Int(equity)))]
        if !symbols.isEmpty {
            items.append(URLQueryItem(name: "symbols", value: symbols.joined(separator: ",")))
        }
        comps?.queryItems = items
        guard let url = comps?.url else { return nil }

        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        PushService.addAuthHeaders(&req)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(Book.self, from: data)
        } catch {
            return nil
        }
    }
}
