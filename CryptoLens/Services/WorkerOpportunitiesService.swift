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

        // ── The detail a row deliberately hides ────────────────────────────────────────────────
        // All three are optional so the app keeps working against a box that predates them: a
        // missing field renders as absent, never as zero. `expectedValueR` above is already NET.

        /// What the 0.171% round trip costs in R. Larger than the whole edge on a tight stop, which
        /// is the single most decisive number in this pipeline and was never once displayed.
        let feeBurdenR: Double?
        /// Before the fee. The pair is what makes the fee legible — a net number alone hides it.
        let grossExpectedValueR: Double?
        /// How this ends, three ways, with the measured shares. The average only reads correctly
        /// beside the shape that produces it.
        let branches: Branches?

        var id: String { "\(asset)-\(direction)" }

        /// Risk per unit as a fraction of entry — what the stop actually costs if hit.
        var stopDistancePercent: Double {
            guard entry > 0 else { return 0 }
            return abs(entry - stop) / entry * 100
        }
    }

    /// Measured outcome shares for one row: reach target, stop out, or exit at the horizon.
    struct Branches: Decodable {
        let target: Double
        let stop: Double
        let timeout: Double
        /// What a timeout pays on average. NOT zero — a bounded horizon exit is worth ~+1.4R at
        /// this structure, which is why the expected value is three-way rather than binary.
        let timeoutPayR: Double
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
        /// The MEASURED hit rate at the primary target per side, with no model applied.
        ///
        /// This is what the LONG side falls back to, because the long head failed its bar
        /// (cross-sectional AUC 0.5421 under a 0.55 floor). It is the whole reason a long carries
        /// no ranking, so the screen quotes it — from here, never from a literal that would go
        /// stale at the next retrain.
        let baseWinRate: BaseWinRate?
    }

    struct BaseWinRate: Decodable {
        let long: Double?
        let short: Double?
    }

    /// The frozen trade structure every row shares. Stated once above the rows, never per card.
    struct Structure: Decodable {
        let roundTripPercent: Double
        let targetR: Double
        let stopAtrMultiple: Double
        let holdingHorizonHours: Double
    }

    /// The best candidate that scored but missed the display floor.
    ///
    /// "Nothing qualifies" and "the best one missed by a cent" are different messages, and only the
    /// second teaches what the floor is. On a quiet day this is the most instructive line on screen.
    struct NearMiss: Decodable {
        let asset: String
        let direction: String
        let expectedValueR: Double
    }

    /// One asset's drawdown reading, warning or not.
    ///
    /// Warnings fire on the MARGIN over the base rate, so most days there are none — and a gauge
    /// that shows nothing most days teaches the user it is broken. The reading is the product.
    struct CrashReading: Decodable, Identifiable {
        let asset: String
        let probability: Double
        var id: String { asset }
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
        let crashReadings: [CrashReading]?
        let crashModel: CrashModelInfo?

        // Optional for the same reason as the row fields: the app must not break on the deploy gap.
        /// How many assets were looked at — the denominator every count on the screen needs.
        let scanned: Int?
        /// The expected-value floor a row must clear, in R. Named in the answer line.
        let floorR: Double?
        let nearMiss: NearMiss?
        /// Market-wide, never per row: drawing it on a card would fabricate per-asset specificity.
        let fearGreed: Double?
        let structure: Structure?

        /// Rows that carry a ranking. A direction-agnostic row does NOT: the pipeline could not
        /// separate the two sides, so its nominal direction is an artifact of needing one, not a
        /// view. Presenting it as a proposal would manufacture the confidence the flag exists to
        /// deny — so it is listed as unranked instead.
        var ranked: [Opportunity] { opportunities.filter { !$0.directionAgnostic } }
        var noView: [Opportunity] { opportunities.filter { $0.directionAgnostic } }
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

#if DEBUG
extension WorkerOpportunitiesService {

    /// A populated book, decoded from a payload shaped exactly as the worker emits one.
    ///
    /// Exists because the scanner's POPULATED state is the rare one — most days nothing clears the
    /// floor — so without this it ships having only ever been looked at empty. This project's own
    /// history is emphatic that a green build does not prove a screen: the 2026-07-25 pass found a
    /// leftover purple badge and harsh pure-red pills only by installing and screenshotting.
    ///
    /// It decodes rather than constructs, so it also asserts the DTO against the real key names. A
    /// renamed field fails here loudly instead of silently arriving as nil in production.
    ///
    /// Reached with `-opportunitiesDemo 1` as a launch argument. DEBUG only.
    static func demoBook() -> Book? {
        let json = """
        {
          "at": 1787842800000,
          "provisional": true,
          "caveat": "Ranking is measured and regime-independent; PROFITABILITY is not. This structure was profitable in only 1 of 5 rising-market periods tested (corr with BTC return −0.51), and its edge is +0.109R gross with a median of zero — mostly nothing, occasionally a large hit.",
          "model": { "version": "excursion-v2", "primaryR": 5, "features": 110,
                     "longAuc": 0.5916, "shortAuc": 0.59,
                     "baseWinRate": { "long": 0.0762, "short": 0.0756 } },
          "modelVersion": "excursion-v2",
          "equity": 28000,
          "scanned": 24,
          "floorR": 0.05,
          "fearGreed": 52,
          "nearMiss": { "asset": "ADAUSDT", "direction": "SHORT", "expectedValueR": 0.041 },
          "structure": { "roundTripPercent": 0.171, "targetR": 5, "stopAtrMultiple": 1,
                         "holdingHorizonHours": 72 },
          "opportunities": [
            { "asset": "SOLUSDT", "direction": "SHORT", "directionAgnostic": false,
              "entry": 186.40, "stop": 190.35, "target": 176.20,
              "expectedValueR": 0.073, "payoffAsymmetry": 5, "winProbability": 0.0791,
              "score": 0.31, "riskFraction": 0.0144, "notionalFraction": 0.68,
              "positionUsd": 19040, "crashMultiplier": 0.72,
              "bindingConstraints": ["crash ELEVATED ×0.72"],
              "feeBurdenR": 0.0806, "grossExpectedValueR": 0.1536,
              "branches": { "target": 0.0791, "stop": 0.7159, "timeout": 0.205, "timeoutPayR": 1.431 } },
            { "asset": "LINKUSDT", "direction": "SHORT", "directionAgnostic": false,
              "entry": 13.42, "stop": 13.72, "target": 11.92,
              "expectedValueR": 0.058, "payoffAsymmetry": 5, "winProbability": 0.0764,
              "score": 0.28, "riskFraction": 0.02, "notionalFraction": 0.89,
              "positionUsd": 24920, "crashMultiplier": 1,
              "bindingConstraints": ["max risk per trade"],
              "feeBurdenR": 0.0765, "grossExpectedValueR": 0.1345,
              "branches": { "target": 0.0764, "stop": 0.7186, "timeout": 0.205, "timeoutPayR": 1.431 } },
            { "asset": "BTCUSDT", "direction": "LONG", "directionAgnostic": true,
              "entry": 64230, "stop": 63588, "target": 67440,
              "expectedValueR": 0.061, "payoffAsymmetry": 5, "winProbability": 0.0772,
              "score": 0.29, "riskFraction": 0.018, "notionalFraction": 0.8,
              "positionUsd": 22400, "crashMultiplier": 1, "bindingConstraints": [],
              "feeBurdenR": 0.171, "grossExpectedValueR": 0.232,
              "branches": { "target": 0.0772, "stop": 0.7178, "timeout": 0.205, "timeoutPayR": 1.431 } }
          ],
          "totals": { "riskFraction": 0.0524, "notionalFraction": 2.37, "positions": 3,
                      "effectiveBets": 1.5 },
          "crashWarnings": [
            { "asset": "SOLUSDT", "level": "ELEVATED",
              "message": "A 10%+ drop in the next 10 days looks 49% likely — 8 points above a normal day. Position sizes are reduced.",
              "probability": 0.49 }
          ],
          "crashReadings": [
            { "asset": "SOLUSDT", "probability": 0.49 },
            { "asset": "XRPUSDT", "probability": 0.46 },
            { "asset": "BTCUSDT", "probability": 0.42 }
          ],
          "crashModel": { "version": "crash-v1", "horizonDays": 10, "baseRate": 0.41,
                          "walkForwardAuc": [0.59, 0.60, 0.60] },
          "skipped": [
            { "asset": "ETHUSDT", "reasons": ["LONG: non-positive expected value (-0.082R)",
                                              "SHORT: non-positive expected value (-0.014R)"] },
            { "asset": "DOGEUSDT", "reasons": ["analysis says stand aside: ANY_KILLED=true, alignment_MIXED_not_full"] },
            { "asset": "AVAXUSDT", "reasons": ["SHORT: stop inside the noise band (P=52%)"] },
            { "asset": "TIAUSDT", "reasons": ["no cached prediction"] }
          ]
        }
        """
        return try? JSONDecoder().decode(Book.self, from: Data(json.utf8))
    }
}
#endif
