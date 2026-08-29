import Foundation

// MARK: - Setup Classification

enum SetupType: String, Codable {
    case market      // Enter at current price immediately
    case conditional // Wait for price to reach entry, then re-evaluate

    /// Classify a setup based on entry distance and reasoning text.
    static func classify(entry: Double, currentPrice: Double, reasoning: String) -> SetupType {
        let distPct = abs(entry - currentPrice) / currentPrice
        if distPct > 0.003 { return .conditional }

        let lower = reasoning.lowercased()
        let conditionalKeywords = ["wait for", "close above", "close below", "confirms",
                                    "breakout", "rejection", "retest"]
        if conditionalKeywords.contains(where: { lower.contains($0) }) { return .conditional }

        return .market
    }
}

// MARK: - Setup State Machine

enum SetupState: String, Codable {
    case pending       // Conditional, waiting for entry trigger
    case active        // Entry confirmed, tracking normally
    case invalidated   // Re-eval failed, not counted in stats
    case expired       // 12h timeout, not counted in stats
}

// MARK: - Re-Evaluation Result

struct ReEvalResult: Codable {
    let direction: String       // Direction from latest analysis
    let mlWin: Double?          // Current ML_WIN
    let killsActive: Bool       // Kill conditions active now
    let validated: Bool         // Did re-eval confirm the setup?
    let reason: String          // Human-readable explanation
}

// MARK: - Trade Setup

struct TradeSetup: Codable, Identifiable {
    let id: UUID
    let direction: String      // "LONG" or "SHORT"
    let entry: Double
    let stopLoss: Double
    let tp1: Double
    let tp2: Double?
    let reasoning: String

    enum CodingKeys: String, CodingKey {
        case id, direction, entry, stopLoss, tp1, tp2, reasoning
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? c.decode(UUID.self, forKey: .id)) ?? UUID()
        self.direction = try c.decode(String.self, forKey: .direction)
        self.entry = try c.decode(Double.self, forKey: .entry)
        self.stopLoss = try c.decode(Double.self, forKey: .stopLoss)
        self.tp1 = try c.decode(Double.self, forKey: .tp1)
        self.tp2 = try c.decodeIfPresent(Double.self, forKey: .tp2)
        self.reasoning = (try? c.decode(String.self, forKey: .reasoning)) ?? ""
    }

    init(direction: String, entry: Double, stopLoss: Double, tp1: Double, tp2: Double? = nil, reasoning: String = "") {
        self.id = UUID()
        self.direction = direction
        self.entry = entry
        self.stopLoss = stopLoss
        self.tp1 = tp1
        self.tp2 = tp2
        self.reasoning = reasoning
    }

    /// Id-carrying init for server-sourced setups (GET /tracked-setups). The server mints the
    /// uuid at registration; keeping it makes `TrackedSetup.id` stable across refreshes
    /// (Identifiable — SwiftUI list diffing depends on it).
    init(id: UUID, direction: String, entry: Double, stopLoss: Double, tp1: Double, tp2: Double? = nil, reasoning: String = "") {
        self.id = id
        self.direction = direction
        self.entry = entry
        self.stopLoss = stopLoss
        self.tp1 = tp1
        self.tp2 = tp2
        self.reasoning = reasoning
    }

    var risk: Double { abs(entry - stopLoss) }

    func rrRatio(for tp: Double) -> Double {
        guard risk > 0 else { return 0 }
        return abs(tp - entry) / risk
    }

    var rrTP1: Double { rrRatio(for: tp1) }
    var rrTP2: Double? { tp2.map { rrRatio(for: $0) } }

}

// MARK: - Trade Outcome

/// Tracks what happened after a setup was generated.
struct TradeOutcome: Codable {
    var entryHit: Bool
    var entryHitTime: Date?
    var stopHit: Bool
    var tp1Hit: Bool
    var tp2Hit: Bool
    var maxFavorable: Double
    var maxAdverse: Double
    var outcomeTime: Date?

    // Trade management milestones
    var breakevenActivated: Bool   // Stop moved to entry after +1.0 R:R
    var partialTaken: Bool         // Partial exit at +1.0 R:R

    // Setup state machine
    var state: SetupState
    var pendingExpiresAt: Date?    // 12h after creation for conditional setups
    var reEvalResult: ReEvalResult?

    /// TERMINAL state — the trade is fully done and excursion tracking should STOP.
    /// True only on a hard close: invalidated, expired, stop hit, or TP2 hit.
    /// `tp1Hit` is deliberately NOT terminal — after TP1 the runner continues (stop
    /// trails to break-even) until TP2 or the stop resolves it.
    ///
    /// ⚠️ Use THIS (never `isCounted`) for loop-termination / "stop tracking" checks.
    /// The two differ on purpose: a 2026-05-09 regression used `isCounted` here, which
    /// is true on `tp1Hit` alone, so every post-TP1 bar skipped tracking and 23/24
    /// winners never registered TP2. Keep `resolved` = `stopHit || tp2Hit` (+ terminal
    /// states); do not fold `tp1Hit` into it.
    var resolved: Bool {
        state == .invalidated || state == .expired ||
        stopHit || tp2Hit
    }

    /// Whether this setup should be COUNTED in win/loss statistics — a different
    /// question from whether it's `resolved`. True once an active setup has reached any
    /// outcome-bearing milestone (`tp1Hit` included, since a TP1 hit is a recordable win
    /// even while the runner is still live). Intended ONLY for stats/active-list filters
    /// — NOT for loop termination (use `resolved` for that; see the warning above).
    var isCounted: Bool {
        state == .active && (stopHit || tp1Hit || tp2Hit)
    }

    init() {
        entryHit = false; entryHitTime = nil; stopHit = false
        tp1Hit = false; tp2Hit = false
        maxFavorable = 0; maxAdverse = 0; outcomeTime = nil
        breakevenActivated = false; partialTaken = false
        state = .active; pendingExpiresAt = nil; reEvalResult = nil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entryHit = try c.decode(Bool.self, forKey: .entryHit)
        entryHitTime = try c.decodeIfPresent(Date.self, forKey: .entryHitTime)
        stopHit = try c.decode(Bool.self, forKey: .stopHit)
        tp1Hit = try c.decode(Bool.self, forKey: .tp1Hit)
        tp2Hit = try c.decode(Bool.self, forKey: .tp2Hit)
        maxFavorable = try c.decode(Double.self, forKey: .maxFavorable)
        maxAdverse = try c.decode(Double.self, forKey: .maxAdverse)
        outcomeTime = try c.decodeIfPresent(Date.self, forKey: .outcomeTime)
        breakevenActivated = (try? c.decode(Bool.self, forKey: .breakevenActivated)) ?? false
        partialTaken = (try? c.decode(Bool.self, forKey: .partialTaken)) ?? false
        state = (try? c.decode(SetupState.self, forKey: .state)) ?? .active
        pendingExpiresAt = try? c.decodeIfPresent(Date.self, forKey: .pendingExpiresAt)
        reEvalResult = try? c.decodeIfPresent(ReEvalResult.self, forKey: .reEvalResult)
    }

    var result: String {
        if state == .invalidated { return "invalidated" }
        if state == .expired { return "expired" }
        if state == .pending { return "pending" }
        if !entryHit { return "not_triggered" }
        if tp2Hit { return "tp2_win" }
        if tp1Hit && stopHit { return "tp1_win" }  // Runner stopped at BE after TP1
        if stopHit && partialTaken { return "partial_be" }  // Partial taken, runner stopped at BE
        if stopHit { return "loss" }
        if tp1Hit { return "tp1_win" }
        return "open"
    }

    /// Human-readable management status for live trades
    var managementStatus: String {
        if state == .pending { return "Pending entry" }
        if !entryHit { return "Waiting for entry" }
        if partialTaken && !resolved { return "Partial taken, trailing" }
        if breakevenActivated && !resolved { return "BE active" }
        return "Tracking"
    }
}

// MARK: - FLAT Outcome

/// Tracks FLAT/kill outcomes to detect false conservatism.
struct FlatOutcome: Codable {
    let symbol: String
    let priceAtFlat: Double
    let timestamp: Date
    let reason: String
    var priceAfter3Refreshes: Double?
    var refreshCount: Int
    var falseFlat: Bool?

    init(symbol: String, price: Double, reason: String) {
        self.symbol = symbol; self.priceAtFlat = price
        self.timestamp = Date(); self.reason = reason
        self.refreshCount = 0; self.falseFlat = nil
    }

    /// Full init for server-sourced FLAT rows (GET /tracked-setups). The server grades FLATs at
    /// a fixed +24h horizon; `refreshCount` is stamped 3 when resolved so the dashboard's
    /// `falseFlat != nil` / evaluated filters keep working unchanged.
    init(symbol: String, priceAtFlat: Double, timestamp: Date, reason: String,
         priceAfter: Double?, falseFlat: Bool?) {
        self.symbol = symbol; self.priceAtFlat = priceAtFlat
        self.timestamp = timestamp; self.reason = reason
        self.priceAfter3Refreshes = priceAfter
        self.refreshCount = falseFlat != nil ? 3 : 0
        self.falseFlat = falseFlat
    }
}

/// Response from Claude with both markdown and structured setups.
struct ClaudeAnalysisResponse {
    let markdown: String
    let setups: [TradeSetup]
}
