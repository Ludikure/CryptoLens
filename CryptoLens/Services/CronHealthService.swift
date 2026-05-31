import Foundation

/// Polls the worker's public `/cron-health` dead-man's-switch. The cron stamps a heartbeat
/// after each full pass; the endpoint returns 503 when it goes stale (> 10 min). If the cron
/// is down, ML scores and notifications silently stop — this surfaces that to the user.
/// (The primary alarm is an external uptime monitor on the same endpoint; this is the
/// in-app secondary so the user isn't left guessing why scores froze.)
enum CronHealthService {
    /// Returns true if the pipeline is stale, false if healthy, nil if unreachable
    /// (network down — don't false-alarm). Public endpoint, no auth needed.
    static func isStale() async -> Bool? {
        guard let url = URL(string: "\(PushService.workerURL)/cron-health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        // 503 = stale, 200 = healthy
        if http.statusCode == 503 { return true }
        if http.statusCode == 200 { return false }
        return nil
    }
}
