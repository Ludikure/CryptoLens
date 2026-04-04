import Foundation
import SwiftData

@Model
class AnalysisState {
    @Attribute(.unique) var symbol: String
    var lastRegime: String
    var divergenceDuration: Int
    var volumeDuration: Int
    var fundingDuration: Int
    var lastUpdated: Date

    init(symbol: String) {
        self.symbol = symbol
        self.lastRegime = ""
        self.divergenceDuration = 0
        self.volumeDuration = 0
        self.fundingDuration = 0
        self.lastUpdated = Date()
    }
}

/// Snapshot of kill state at the time a setup was generated.
struct KillSnapshot: Codable {
    let divergenceDuration: Int
    let volumeDuration: Int
    let fundingDuration: Int
    let anyKilled: Bool
}
