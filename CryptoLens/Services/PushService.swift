import Foundation

/// Syncs alerts and device token to the Cloudflare Worker.
/// Auth: server-issued token obtained on first registration.
enum PushService {
    static let workerURL = "https://marketscope-proxy.ludikure.workers.dev"

    /// Stable device identifier.
    static let deviceId: String = {
        if let existing = UserDefaults.standard.string(forKey: "device_id") {
            return existing
        }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "device_id")
        return id
    }()

    /// Server-issued auth token (obtained from /register, persisted in Keychain).
    private static let authTokenKey = "worker_auth_token"

    static var authToken: String? {
        get { KeychainHelper.load(key: authTokenKey) }
        set {
            if let v = newValue { KeychainHelper.save(key: authTokenKey, value: v) }
            else { KeychainHelper.delete(key: authTokenKey) }
        }
    }

    /// Add auth headers to any worker request.
    static func addAuthHeaders(_ request: inout URLRequest) {
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
        if let token = authToken {
            request.setValue(token, forHTTPHeaderField: "X-Auth-Token")
        }
    }

    /// Register device and obtain auth token from worker.
    static func registerDevice(token: String) {
        Task {
            guard let url = URL(string: "\(workerURL)/register") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
            // Include existing auth token if we have one (for push token update)
            if let existing = authToken {
                request.setValue(existing, forHTTPHeaderField: "X-Auth-Token")
            }
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": token])

            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode)
            else { return }

            // New device gets authToken in response; existing device already has it
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let serverToken = json["authToken"] as? String {
                authToken = serverToken
            }
        }
    }

    /// Register device without push token (just to get auth token on first launch).
    static func ensureRegistered() {
        guard authToken == nil else { return }
        Task {
            guard let url = URL(string: "\(workerURL)/register") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
            request.httpBody = try? JSONSerialization.data(withJSONObject: [:] as [String: String])

            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let serverToken = json["authToken"] as? String
            else { return }

            authToken = serverToken
        }
    }

    /// Sync current alerts to the worker.
    static func syncAlerts(_ alerts: [PriceAlert]) {
        Task {
            guard let url = URL(string: "\(workerURL)/alerts") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            addAuthHeaders(&request)

            let payload = alerts.filter { !$0.triggered }.map { alert -> [String: Any] in
                [
                    "id": alert.id.uuidString,
                    "symbol": alert.symbol,
                    "targetPrice": alert.targetPrice,
                    "condition": alert.condition.rawValue,
                    "note": alert.note,
                    "triggered": false,
                ]
            }

            request.httpBody = try? JSONSerialization.data(withJSONObject: ["alerts": payload])
            _ = try? await URLSession.shared.data(for: request)
        }
    }
}
