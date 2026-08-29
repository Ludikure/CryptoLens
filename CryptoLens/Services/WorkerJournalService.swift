import Foundation

/// Phase 3 — the journal of what YOU did, and the attribution of it against what the system
/// proposed. Definitions are pre-declared in `docs/research/journal-attribution.md`; the worker
/// computes everything (`GET /attribution`) so this stays a thin decode + three writes.
///
/// The verdict rule is the worker's, not the phone's: nothing is called a finding until taken ≥ 10
/// AND skipped ≥ 10 graded trades. The phone renders `verdict.status` as it arrives.
enum WorkerJournalService {
    /// Mirrors VERDICT_MIN_TAKEN / VERDICT_MIN_SKIPPED in src/journal.ts. Display only — the
    /// worker's `verdict.needTaken` / `needSkipped` are what the screen counts down.
    static let minTaken = 10
    static let minSkipped = 10


    struct GroupStats: Decodable {
        let n: Int
        let effectiveN: Int
        let graded: Int
        let expectancyR: Double?
        let winRate: Double?
        let avgMfeR: Double?
        let avgMaeR: Double?
        /// `Infinity` on the wire serialises as null, so a loss-free group decodes as nil here.
        let profitFactor: Double?
        let avgFeeR: Double?
        let byMonth: [Month]
        let consistency: Consistency?

        struct Month: Decodable { let month: String; let n: Int; let meanR: Double }
        struct Consistency: Decodable { let positive: Int; let months: Int }
    }

    struct Verdict: Decodable {
        let status: String            // "insufficient" | "ready"
        let needTaken: Int
        let needSkipped: Int
        let selection: String?        // picks_beat_list | list_beat_picks | no_difference
        let abstention: String?       // skipping_helped | skipped_winners | no_difference
    }

    /// One journal row as stored (snake_case on the wire — the worker returns D1 rows verbatim).
    struct Entry: Decodable, Identifiable {
        let id: String
        let createdAt: Double
        let updatedAt: Double
        let source: String            // setup | opportunity | manual
        let refId: String?
        let symbol: String
        let isCrypto: Int
        let direction: String
        let proposedEntry: Double?
        let proposedStop: Double?
        let proposedTarget: Double?
        let fillPrice: Double
        let contracts: Double?
        let riskUsd: Double?
        let note: String?
        let exitPrice: Double?
        let exitAt: Double?
        let exitReason: String?
        let status: String            // open | closed

        enum CodingKeys: String, CodingKey {
            case id, source, symbol, direction, contracts, note, status
            case createdAt = "created_at", updatedAt = "updated_at", refId = "ref_id"
            case isCrypto = "is_crypto", proposedEntry = "proposed_entry", proposedStop = "proposed_stop"
            case proposedTarget = "proposed_target", fillPrice = "fill_price", riskUsd = "risk_usd"
            case exitPrice = "exit_price", exitAt = "exit_at", exitReason = "exit_reason"
        }

        /// YOUR realised R, computable only once there is a fill, a stop and an exit.
        var realizedR: Double? {
            guard let exit = exitPrice, let stop = proposedStop else { return nil }
            let risk = abs(fillPrice - stop)
            guard risk > 0 else { return nil }
            return direction == "LONG" ? (exit - fillPrice) / risk : (fillPrice - exit) / risk
        }
    }

    struct Attribution: Decodable {
        let proposed: GroupStats
        let taken: GroupStats
        let skipped: GroupStats
        let selectionR: Double?
        let selectionCI: [Double]?
        let abstentionR: Double?
        let abstentionCI: [Double]?
        let executionDragR: Double?
        let executionN: Int
        let verdict: Verdict
        let note: String
        let entries: [Entry]
    }

    struct Create: Encodable {
        let source: String
        let refId: String?
        let symbol: String
        let direction: String
        let proposedEntry: Double?
        let proposedStop: Double?
        let proposedTarget: Double?
        let fillPrice: Double
        let contracts: Double?
        let riskUsd: Double?
        let note: String?
    }

    struct Close: Encodable {
        let id: String
        let exitPrice: Double
        let exitReason: String?
        let note: String?
    }

    static func fetch() async -> Attribution? {
        guard let url = URL(string: "\(PushService.workerURL)/attribution") else { return nil }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        PushService.addAuthHeaders(&request)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode == 401 { await PushService.handleAuthFailure(); return nil }
            guard (200..<300).contains(http.statusCode) else {
                print("[WorkerJournalService] HTTP \(http.statusCode)"); return nil
            }
            return try JSONDecoder().decode(Attribution.self, from: data)
        } catch {
            print("[WorkerJournalService] fetch failed: \(error)"); return nil
        }
    }

    @discardableResult
    static func create(_ body: Create) async -> Bool {
        await send(method: "POST", body: body)
    }

    @discardableResult
    static func close(_ body: Close) async -> Bool {
        await send(method: "PUT", body: body)
    }

    @discardableResult
    static func delete(id: String) async -> Bool {
        guard var comps = URLComponents(string: "\(PushService.workerURL)/journal") else { return false }
        comps.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let url = comps.url else { return false }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 12
        PushService.addAuthHeaders(&request)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0) / 100 == 2
        } catch { return false }
    }

    private static func send<T: Encodable>(method: String, body: T) async -> Bool {
        guard let url = URL(string: "\(PushService.workerURL)/journal") else { return false }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        do {
            request.httpBody = try JSONEncoder().encode(body)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            if http.statusCode == 401 { await PushService.handleAuthFailure(); return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            print("[WorkerJournalService] \(method) failed: \(error)"); return false
        }
    }
}
