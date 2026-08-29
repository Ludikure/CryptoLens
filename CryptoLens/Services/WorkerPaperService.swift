import Foundation

/// The paper trader's state, as the box serves it (`GET /paper`). The bot lives on the box
/// (`server/paper-trader.ts`) and fills simulated shorts against the REAL Coinbase order book;
/// the phone only displays and flips the enable switch. Every number here is the box's.
enum WorkerPaperService {

    struct Position: Decodable, Identifiable {
        let id: String
        let symbol: String
        let productId: String
        let contractSize: Double
        let contracts: Double
        let entryPrice: Double
        let entrySlippageBps: Double
        let stopPrice: Double
        let targetPrice: Double
        let riskUsd: Double
        let openedAt: Double
        let expiresAt: Double
        let feesUsd: Double
        let status: String
        let exitPrice: Double?
        let exitAt: Double?
        let exitReason: String?
        let pnlUsd: Double?
        let realizedR: Double?
        /// Present on OPEN rows only — the box marks them at the best ask.
        let unrealizedUsd: Double?
        let mark: Double?
    }

    struct Status: Decodable {
        let state: String
        let feedHealthy: Bool
        let messages: Int
        let lastSignalRunAt: Double?
        let lastSignalSummary: String?
        let lastError: String?
        let contracts: [String: String?]
    }

    struct Stats: Decodable {
        let n: Int
        let meanR: Double?
        let winRate: Double?
        /// `Infinity` serialises as null when there are no losses yet.
        let profitFactor: Double?
        let pnlUsd: Double
        let feesUsd: Double
        let maxDrawdownUsd: Double
        let equity: Double
        let byReason: [String: Int]
        let avgEntrySlippageBps: Double?
    }

    struct Reference: Decodable { let meanR: Double; let note: String }

    struct Book: Decodable { let ready: Bool; let bid: Double?; let ask: Double?; let spreadBps: Double? }

    struct State: Decodable {
        let running: Bool
        let enabled: Bool
        let halted: String?
        let status: Status?
        let symbols: [String]?
        let risk: Double?
        let startEquity: Double
        let equity: Double
        let open: [Position]
        let books: [String: Book]
        let closed: [Position]
        let stats: Stats?
        let backtestReference: Reference
    }

    static func fetch() async -> State? {
        guard let url = URL(string: "\(PushService.workerURL)/paper") else { return nil }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        PushService.addAuthHeaders(&request)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode == 401 { await PushService.handleAuthFailure(); return nil }
            guard (200..<300).contains(http.statusCode) else {
                print("[WorkerPaperService] HTTP \(http.statusCode)"); return nil
            }
            return try JSONDecoder().decode(State.self, from: data)
        } catch {
            print("[WorkerPaperService] fetch failed: \(error)"); return nil
        }
    }

    struct Command: Encodable {
        var enabled: Bool? = nil
        var clearHalt: Bool? = nil
        var closeId: String? = nil
        var runNow: Bool? = nil
    }

    @discardableResult
    static func send(_ cmd: Command) async -> Bool {
        guard let url = URL(string: "\(PushService.workerURL)/paper") else { return false }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        do {
            request.httpBody = try JSONEncoder().encode(cmd)
            let (_, response) = try await URLSession.shared.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0) / 100 == 2
        } catch { return false }
    }
}
