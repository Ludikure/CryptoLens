import Foundation

/// Syncs alerts and device token to the Cloudflare Worker for server-side push notifications.
enum PushService {
    static let workerURL = "https://marketscope-proxy.ludikure.workers.dev"

    /// Register device token with the worker.
    static func registerDevice(token: String) {
        Task {
            guard let url = URL(string: "\(workerURL)/register") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": token])
            _ = try? await URLSession.shared.data(for: request)
            #if DEBUG
            print("[MarketScope] Device token registered")
            #endif
        }
    }

    /// Sync current alerts to the worker.
    static func syncAlerts(_ alerts: [PriceAlert]) {
        Task {
            guard let url = URL(string: "\(workerURL)/alerts") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

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
            #if DEBUG
            print("[MarketScope] Synced \(payload.count) alerts to worker")
            #endif
        }
    }
}
