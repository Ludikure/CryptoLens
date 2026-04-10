import Foundation

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

    var risk: Double { abs(entry - stopLoss) }

    func rrRatio(for tp: Double) -> Double {
        guard risk > 0 else { return 0 }
        return abs(tp - entry) / risk
    }

    var rrTP1: Double { rrRatio(for: tp1) }
    var rrTP2: Double? { tp2.map { rrRatio(for: $0) } }

    /// Generate price alerts for this setup.
    func toAlerts(symbol: String, currentPrice: Double) -> [PriceAlert] {
        var alerts = [PriceAlert]()
        let groupId = UUID()

        func alertCondition(for target: Double) -> PriceAlert.Condition {
            currentPrice > target ? .below : .above
        }

        alerts.append(PriceAlert(
            symbol: symbol,
            targetPrice: entry,
            condition: alertCondition(for: entry),
            note: "\(direction) entry",
            setupId: groupId
        ))

        alerts.append(PriceAlert(
            symbol: symbol,
            targetPrice: stopLoss,
            condition: alertCondition(for: stopLoss),
            note: "\(direction) stop loss",
            setupId: groupId
        ))

        alerts.append(PriceAlert(
            symbol: symbol,
            targetPrice: tp1,
            condition: alertCondition(for: tp1),
            note: "\(direction) TP1",
            setupId: groupId
        ))
        if let tp2 = tp2 {
            alerts.append(PriceAlert(
                symbol: symbol,
                targetPrice: tp2,
                condition: alertCondition(for: tp2),
                note: "\(direction) TP2",
                setupId: groupId
            ))
        }

        return alerts
    }
}

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
    var resolved: Bool { stopHit || tp1Hit }

    init() {
        entryHit = false; entryHitTime = nil; stopHit = false
        tp1Hit = false; tp2Hit = false
        maxFavorable = 0; maxAdverse = 0; outcomeTime = nil
    }

    var result: String {
        if !entryHit { return "not_triggered" }
        if stopHit { return "loss" }
        if tp2Hit { return "tp2_win" }
        if tp1Hit { return "tp1_win" }
        return "open"
    }
}

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
}

/// Response from Claude with both markdown and structured setups.
struct ClaudeAnalysisResponse {
    let markdown: String
    let setups: [TradeSetup]
}
