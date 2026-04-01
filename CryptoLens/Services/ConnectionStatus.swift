import Foundation

/// Tracks health of each data source for UI badges.
@MainActor
class ConnectionStatus: ObservableObject {
    static let shared = ConnectionStatus()

    enum SourceState: String {
        case ok = "OK"
        case idle = "Idle"       // Not yet called
        case pending = "Pending"
        case error = "Error"
        case offline = "Offline"
    }

    @Published var workerAuth: SourceState = PushService.authToken != nil ? .ok : .pending
    @Published var binance: SourceState = .idle
    @Published var twelveData: SourceState = .idle
    @Published var finnhub: SourceState = .idle
    @Published var macro: SourceState = .idle
    @Published var ai: SourceState = .idle
    @Published var alertSync: SourceState = .ok
    @Published var pendingOfflineChanges = false

    @Published var yahooFinance: SourceState = .idle

    var overallState: String {
        if NetworkMonitor.shared.isOffline { return "Offline" }
        if workerAuth == .error { return "Auth failed" }
        if workerAuth == .pending && PushService.authToken == nil { return "Connecting..." }
        return "Connected"
    }

    var overallColor: String {
        if NetworkMonitor.shared.isOffline { return "red" }
        if workerAuth == .error { return "red" }
        if workerAuth == .pending { return "orange" }
        return "green"
    }
}
