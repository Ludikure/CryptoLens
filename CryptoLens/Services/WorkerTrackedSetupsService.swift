import Foundation

/// Fetches server-resolved tracked setups from `GET /tracked-setups` (2026-07-09 thin-client
/// cutover). The box registers every setup/FLAT at analysis time and resolves them on its
/// per-minute cron — the phone no longer registers or resolves anything. `OutcomeTracker`
/// calls this from `refresh()` and maps the DTOs into `TrackedSetup`/`FlatOutcome` for all
/// existing dashboard/stats consumers.
enum WorkerTrackedSetupsService {

    /// One tracked_setups row as the worker serves it (camelCase, epoch-ms timestamps).
    /// `kind == "setup"` rows land in `setups`, `kind == "flat"` rows in `flats` server-side.
    struct SetupDTO: Decodable {
        let id: String
        let symbol: String
        let isCrypto: Bool
        let direction: String?
        let entry: Double?
        let stopLoss: Double?
        let tp1: Double?
        let tp2: Double?
        let reasoning: String?
        let priceAtSetup: Double
        let atr: Double?
        let mlAtRegistration: Double?
        let conviction: String?
        let modelVersion: Int
        let promptVersion: String
        let archetype: String?
        let setupType: String?
        let state: String
        let terminal: Bool
        let entryHit: Bool
        let entryHitAt: Double?
        let stopHit: Bool
        let tp1Hit: Bool
        let tp2Hit: Bool
        let breakevenActivated: Bool
        let partialTaken: Bool
        let maxFavorable: Double
        let maxAdverse: Double
        let outcome: String?
        let invalidReason: String?
        let flatReason: String?
        let falseFlat: Bool?
        let priceAfter: Double?
        let pendingExpiresAt: Double?
        let registeredAt: Double
        let resolvedAt: Double?
    }

    struct Response: Decodable {
        let setups: [SetupDTO]
        let flats: [SetupDTO]
    }

    /// GET /tracked-setups — full per-device history (server caps at 500; default 200).
    /// Returns nil on any failure so the caller keeps its cached snapshot.
    static func fetch(limit: Int = 500) async -> Response? {
        guard let url = URL(string: "\(PushService.workerURL)/tracked-setups?limit=\(limit)") else { return nil }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        PushService.addAuthHeaders(&request)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode == 401 {
                await PushService.handleAuthFailure()
                return nil
            }
            guard (200..<300).contains(http.statusCode) else {
                print("[WorkerTrackedSetupsService] HTTP \(http.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            print("[WorkerTrackedSetupsService] fetch failed: \(error)")
            return nil
        }
    }
}
