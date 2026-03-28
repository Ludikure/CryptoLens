import Foundation

enum CrowdingState: String, Codable {
    case crowdedLong = "Crowded Long"
    case crowdedShort = "Crowded Short"
    case balanced = "Balanced"
}

enum OITrend: String, Codable {
    case building = "Building"
    case unwinding = "Unwinding"
    case stable = "Stable"
}

struct SqueezeRisk: Codable {
    let level: String  // "HIGH", "MODERATE", "LOW", "NONE"
    let direction: String  // "LONG SQUEEZE", "SHORT SQUEEZE", ""
    let description: String
}

struct PositioningSignal: Codable {
    let strength: String  // "Strong", "Moderate", "Weak"
    let message: String
}

struct PositioningSnapshot: Codable {
    let crowding: CrowdingState
    let fundingSentiment: String
    let oiTrend: OITrend
    let smartMoneyBias: String
    let takerPressure: String
    let squeezeRisk: SqueezeRisk
    let signals: [PositioningSignal]
}
