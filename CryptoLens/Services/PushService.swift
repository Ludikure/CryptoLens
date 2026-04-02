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
        request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
        if let token = authToken {
            request.setValue(token, forHTTPHeaderField: "X-Auth-Token")
        }
    }

    /// Handle 401 by clearing expired token, generating new device ID, and re-registering.
    static func handleAuthFailure() async {
        authToken = nil
        // Generate new device ID to get a fresh token (old one expired/invalidated)
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: "device_id")
        await MainActor.run { ConnectionStatus.shared.workerAuth = .pending }
        // Re-register with new identity
        await ensureAuth()
    }

    /// Register device and obtain auth token from worker.
    static func registerDevice(token: String) {
        Task {
            guard let url = URL(string: "\(workerURL)/register") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")
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
    /// Register with retry (up to 3 attempts with backoff).
    /// Called on launch and before any authenticated request if token is missing.
    static func ensureRegistered() {
        guard authToken == nil else { return }
        Task {
            for attempt in 0..<3 {
                if attempt > 0 {
                    try? await Task.sleep(for: .seconds(Double(attempt) * 5))
                }
                guard let url = URL(string: "\(workerURL)/register") else { return }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")
            request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
                request.httpBody = try? JSONSerialization.data(withJSONObject: [:] as [String: String])

                if let (data, response) = try? await URLSession.shared.data(for: request),
                   let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let serverToken = json["authToken"] as? String {
                    authToken = serverToken
                    await MainActor.run { ConnectionStatus.shared.workerAuth = .ok }
                    return
                }
            }
            await MainActor.run { ConnectionStatus.shared.workerAuth = .error }
        }
    }

    /// Guard to prevent concurrent ensureAuth calls from double-registering.
    private static var isAuthenticating = false

    /// Call before any authenticated worker request — retries registration if needed.
    static func ensureAuth() async {
        if authToken != nil { return }
        guard !isAuthenticating else {
            // Another call is already in-flight; wait briefly and check again
            try? await Task.sleep(nanoseconds: 500_000_000)
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        await MainActor.run { ConnectionStatus.shared.workerAuth = .pending }
        for attempt in 0..<2 {
            if attempt > 0 { try? await Task.sleep(for: .seconds(3)) }
            guard let url = URL(string: "\(workerURL)/register") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")
            request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
            request.httpBody = try? JSONSerialization.data(withJSONObject: [:] as [String: String])

            if let (data, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let serverToken = json["authToken"] as? String {
                authToken = serverToken
                await MainActor.run { ConnectionStatus.shared.workerAuth = .ok }
                return
            }
        }
        await MainActor.run { ConnectionStatus.shared.workerAuth = .error }
    }

    /// Sync current alerts to the worker. Marks pending if offline.
    static func syncAlerts(_ alerts: [PriceAlert]) {
        Task {
            let offline = await MainActor.run { NetworkMonitor.shared.isOffline }
            if offline {
                await MainActor.run {
                    ConnectionStatus.shared.alertSync = .pending
                    ConnectionStatus.shared.pendingOfflineChanges = true
                }
                return
            }

            await ensureAuth()
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
            #if DEBUG
            print("[MarketScope] Syncing \(payload.count) alerts to worker...")
            #endif
            if let (data, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse {
                #if DEBUG
                let body = String(data: data, encoding: .utf8) ?? ""
                print("[MarketScope] Alert sync: HTTP \(http.statusCode) — \(body)")
                #endif
                if (200...299).contains(http.statusCode) {
                    await MainActor.run {
                        ConnectionStatus.shared.alertSync = .ok
                        ConnectionStatus.shared.pendingOfflineChanges = false
                    }
                } else {
                    if http.statusCode == 401 { await handleAuthFailure() }
                    await MainActor.run { ConnectionStatus.shared.alertSync = .error }
                }
            } else {
                #if DEBUG
                print("[MarketScope] Alert sync: network error")
                #endif
                await MainActor.run { ConnectionStatus.shared.alertSync = .error }
            }
        }
    }
}
