import Foundation

/// Tracks health of each data source for UI badges.
@MainActor
class ConnectionStatus: ObservableObject {
    static let shared = ConnectionStatus()

    enum SourceState: String {
        case ok = "OK"
        case pending = "Pending"
        case error = "Error"
        case offline = "Offline"
    }

    @Published var workerAuth: SourceState = .pending
    @Published var binance: SourceState = .pending
    @Published var twelveData: SourceState = .pending
    @Published var finnhub: SourceState = .pending
    @Published var macro: SourceState = .pending
    @Published var ai: SourceState = .pending
    @Published var alertSync: SourceState = .ok
    @Published var pendingOfflineChanges = false

    // Legacy compat — views referencing .yahoo
    var yahoo: SourceState {
        get { twelveData }
        set { twelveData = newValue }
    }

    var overallState: String {
        if NetworkMonitor.shared.isOffline { return "Offline" }
        if workerAuth == .pending { return "Connecting..." }
        if workerAuth == .error { return "Auth failed" }
        return "Connected"
    }

    var overallColor: String {
        if NetworkMonitor.shared.isOffline { return "red" }
        if workerAuth == .error { return "red" }
        if workerAuth == .pending { return "orange" }
        return "green"
    }
}
