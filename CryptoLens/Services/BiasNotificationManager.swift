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
    // sendScoreAlert (ML>=60 "tap to analyze setup") removed 2026-07-14 — it paged into no-setup
    // analyses; the server-side auto-analysis push (setup-gated) is the replacement.
}
