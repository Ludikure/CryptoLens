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

    static func sendScoreAlert(ticker: String, score: Int, direction: String) {
        let content = UNMutableNotificationContent()
        content.title = "\(ticker) — High Conviction \(direction)"
        content.body = "Daily score: \(score > 0 ? "+" : "")\(score). Tap to analyze setup."
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "score-\(ticker)-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}
