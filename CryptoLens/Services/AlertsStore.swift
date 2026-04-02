import Foundation
import UserNotifications

@MainActor
class AlertsStore: ObservableObject {
    @Published var alerts: [PriceAlert] {
        didSet { save() }
    }

    private let key = "price_alerts"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let decoded = try? JSONDecoder().decode([PriceAlert].self, from: data) {
            alerts = decoded
        } else {
            alerts = []
        }
    }

    var activeAlerts: [PriceAlert] {
        alerts.filter { !$0.triggered }
    }

    func addAlert(_ alert: PriceAlert) {
        alerts.append(alert)
    }

    func removeAlert(id: UUID) {
        alerts.removeAll { $0.id == id }
    }

    func removeAlerts(at offsets: IndexSet) {
        alerts.remove(atOffsets: offsets)
    }

    func removeSetup(id: UUID) {
        alerts.removeAll { $0.setupId == id }
    }

    func removeAlerts(forSymbol symbol: String) {
        alerts.removeAll { $0.symbol == symbol }
    }

    func clearAll() {
        alerts.removeAll()
    }

    /// Pull server-side triggered state to prevent local re-triggers.
    func syncFromServer() {
        Task {
            await PushService.ensureAuth()
            guard let url = URL(string: "\(PushService.workerURL)/alerts") else { return }
            var request = URLRequest(url: url)
            PushService.addAuthHeaders(&request)

            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let serverAlerts = try? JSONDecoder().decode([ServerAlert].self, from: data)
            else { return }

            let triggeredIds = Set(serverAlerts.filter(\.triggered).map(\.id))
            guard !triggeredIds.isEmpty else { return }

            await MainActor.run {
                var changed = false
                for i in alerts.indices where !alerts[i].triggered {
                    if triggeredIds.contains(alerts[i].id.uuidString) {
                        alerts[i].triggered = true
                        changed = true
                    }
                }
                if changed { save() }
            }
        }
    }

    private struct ServerAlert: Codable {
        let id: String
        let triggered: Bool
    }

    /// Check all active alerts against current prices and fire notifications.
    func checkAlerts(prices: [String: Double]) {
        var changed = false
        for i in alerts.indices where !alerts[i].triggered {
            if let price = prices[alerts[i].symbol], alerts[i].isTriggered(currentPrice: price) {
                alerts[i].triggered = true
                changed = true
                fireNotification(alert: alerts[i], currentPrice: price)
                HapticManager.notification(.warning)
            }
        }
        if changed { save() }
    }

    private func fireNotification(alert: PriceAlert, currentPrice: Double) {
        let coin = Constants.coin(for: alert.symbol)
        let coinName = coin?.name ?? alert.symbol
        let content = UNMutableNotificationContent()
        content.title = "\(coinName) Alert"
        content.body = "\(coinName) is now \(Formatters.formatPrice(currentPrice)) (\(alert.condition.label) \(Formatters.formatPrice(alert.targetPrice)))"
        if !alert.note.isEmpty {
            content.body += "\n\(alert.note)"
        }
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: alert.id.uuidString,
            content: content,
            trigger: nil // fire immediately
        )
        UNUserNotificationCenter.current().add(request)
    }

    static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                #if DEBUG
                print("[MarketScope] Notification permission error: \(error)")
                #endif
            }
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(alerts) {
            UserDefaults.standard.set(data, forKey: key)
        }
        // Sync to Cloudflare Worker for server-side push
        PushService.syncAlerts(alerts)
    }
}
