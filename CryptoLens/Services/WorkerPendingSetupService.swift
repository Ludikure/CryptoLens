import Foundation

/// Registers / cancels conditional pending setups with the Cloudflare Worker so the
/// cron can send an APNs "entry zone reached" notification when the latest 4H bar's
/// high/low touches the entry price ± 0.3 × ATR AND ML is still favorable.
///
/// Fire-and-forget semantics: failures are logged but do not block local setup
/// registration. The local OutcomeTracker remains the source of truth for outcome
/// tracking; this service only pushes the entry-zone metadata to the worker.
enum WorkerPendingSetupService {

    enum FetchError: Error {
        case missingURL
        case unauthorized
        case http(Int)
    }

    /// POST a pending setup to /pending-setups. Worker stores it in D1 and the cron
    /// monitors for entry-zone touches.
    static func register(setupId: UUID, symbol: String, direction: String,
                         entry: Double, atr: Double,
                         mlAtRegistration: Double?,
                         expiresAt: Date) async {
        guard direction == "LONG" || direction == "SHORT" else { return }
        guard atr > 0, entry > 0 else { return }
        guard var components = URLComponents(string: "\(PushService.workerURL)/pending-setups") else {
            return
        }
        components.queryItems = nil
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)

        let body: [String: Any] = [
            "id": setupId.uuidString,
            "symbol": symbol,
            "direction": direction,
            "entry": entry,
            "atr": atr,
            "mlAtRegistration": mlAtRegistration as Any,
            "expiresAt": Int(expiresAt.timeIntervalSince1970 * 1000)
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[WorkerPendingSetupService] register \(symbol) HTTP \(http.statusCode)")
            }
        } catch {
            print("[WorkerPendingSetupService] register \(symbol) failed: \(error)")
        }
    }

    /// DELETE a setup from the worker (when locally invalidated/expired/activated).
    static func cancel(setupId: UUID) async {
        guard var components = URLComponents(string: "\(PushService.workerURL)/pending-setups/\(setupId.uuidString)") else {
            return
        }
        components.queryItems = nil
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 5
        PushService.addAuthHeaders(&request)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[WorkerPendingSetupService] cancel \(setupId) HTTP \(http.statusCode)")
            }
        } catch {
            print("[WorkerPendingSetupService] cancel \(setupId) failed: \(error)")
        }
    }
}
