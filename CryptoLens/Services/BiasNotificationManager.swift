import UserNotifications

enum BiasNotificationManager {
    static func send(ticker: String, oldBias: String, newBias: String) {
        let content = UNMutableNotificationContent()
        content.title = "\(ticker) Bias Changed"
        content.body = "\(oldBias) \u{2192} \(newBias)"
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "bias-\(ticker)-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}
