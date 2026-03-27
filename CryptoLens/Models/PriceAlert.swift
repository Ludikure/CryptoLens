import Foundation

struct PriceAlert: Identifiable, Codable, Equatable {
    let id: UUID
    let symbol: String
    let targetPrice: Double
    let condition: Condition
    let note: String
    let createdAt: Date
    var triggered: Bool
    let setupId: UUID?  // Groups alerts from the same trade setup

    enum Condition: String, Codable, CaseIterable {
        case above = "above"
        case below = "below"

        var label: String {
            switch self {
            case .above: return "Price above"
            case .below: return "Price below"
            }
        }

        var symbol: String {
            switch self {
            case .above: return "≥"
            case .below: return "≤"
            }
        }
    }

    init(symbol: String, targetPrice: Double, condition: Condition, note: String = "", setupId: UUID? = nil) {
        self.id = UUID()
        self.symbol = symbol
        self.targetPrice = targetPrice
        self.condition = condition
        self.note = note
        self.createdAt = Date()
        self.triggered = false
        self.setupId = setupId
    }

    func isTriggered(currentPrice: Double) -> Bool {
        switch condition {
        case .above: return currentPrice >= targetPrice
        case .below: return currentPrice <= targetPrice
        }
    }
}
