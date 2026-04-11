import Foundation

enum MarketSession: String {
    case preMarket = "Pre-Market"
    case regular = "Market Open"
    case postMarket = "After Hours"
    case closed = "Market Closed"
}

enum MarketHours {
    private static let et = TimeZone(identifier: "America/New_York")!

    // MARK: - Finnhub-backed session (primary)

    /// Cached Finnhub market status — updated by fetchFromFinnhub().
    /// Accessed from multiple threads; nonisolated reads are safe because
    /// writes only happen on MainActor and reads tolerate stale data.
    nonisolated(unsafe) private static var finnhubSession: (session: MarketSession, holiday: Bool, fetched: Date)?

    /// Fetch market status from Finnhub via worker. Call on app launch and periodically.
    @MainActor static func fetchFromFinnhub() async {
        await PushService.ensureAuth()
        guard let url = URL(string: "\(PushService.workerURL)/finnhub/market-status?symbol=US") else { return }
        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        let sessionStr = (json["session"] as? String ?? "closed").lowercased()
        let isHoliday = json["holiday"] as? String != nil
        let session: MarketSession
        switch sessionStr {
        case "regular": session = .regular
        case "pre", "pre-market": session = .preMarket
        case "post", "post-market", "after-hours": session = .postMarket
        default: session = .closed
        }
        finnhubSession = (session, isHoliday, Date())
    }

    // MARK: - Public API

    static func currentSession() -> MarketSession {
        // Use Finnhub if fresh (< 10 minutes)
        if let fh = finnhubSession, Date().timeIntervalSince(fh.fetched) < 600 {
            return fh.session
        }
        // Fallback to local computation
        return localSession()
    }

    static func isMarketOpen() -> Bool {
        currentSession() == .regular
    }

    static func isMarketHoliday(date: Date = Date()) -> Bool {
        // Use Finnhub if we have it and it's for today
        if let fh = finnhubSession,
           Date().timeIntervalSince(fh.fetched) < 600,
           Calendar.current.isDateInToday(date) {
            return fh.holiday
        }
        // Fallback to hardcoded holidays
        let key = holidayFormatter.string(from: date)
        return knownHolidays.contains(key)
    }

    // MARK: - Time calculations

    static func timeToNextOpen() -> String? {
        let session = currentSession()
        if session == .regular { return nil }

        let cal = Calendar.current
        let now = Date()
        let comps = cal.dateComponents(in: et, from: now)
        guard let weekday = comps.weekday else { return nil }

        var daysToAdd = 0
        if session == .preMarket {
            daysToAdd = 0
        } else if weekday == 6 { // Friday after close → Monday
            daysToAdd = 3
        } else if weekday == 7 {
            daysToAdd = 2
        } else if weekday == 1 {
            daysToAdd = 1
        } else {
            daysToAdd = 1
        }

        guard let baseDate = cal.date(from: comps) else { return nil }
        guard var targetDay = cal.date(byAdding: .day, value: daysToAdd, to: baseDate) else { return nil }

        var safety = 0
        while isMarketHoliday(date: targetDay) && safety < 10 {
            guard let next = cal.date(byAdding: .day, value: 1, to: targetDay) else { break }
            targetDay = next
            let wd = cal.dateComponents(in: et, from: targetDay).weekday ?? 2
            if wd == 7 {
                targetDay = cal.date(byAdding: .day, value: 2, to: targetDay) ?? targetDay
            } else if wd == 1 {
                targetDay = cal.date(byAdding: .day, value: 1, to: targetDay) ?? targetDay
            }
            safety += 1
        }
        var targetComps = cal.dateComponents(in: et, from: targetDay)
        targetComps.hour = 9
        targetComps.minute = 30
        targetComps.second = 0

        guard let nextOpen = cal.date(from: targetComps) else { return nil }
        let diff = nextOpen.timeIntervalSince(now)
        if diff <= 0 { return nil }

        let hours = Int(diff) / 3600
        let minutes = (Int(diff) % 3600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }

    static func timeToClose() -> String? {
        guard currentSession() == .regular else { return nil }
        let cal = Calendar.current
        let now = Date()
        var comps = cal.dateComponents(in: et, from: now)
        comps.hour = 16
        comps.minute = 0
        comps.second = 0
        guard let close = cal.date(from: comps) else { return nil }
        let diff = close.timeIntervalSince(now)
        if diff <= 0 { return nil }
        let hours = Int(diff) / 3600
        let minutes = (Int(diff) % 3600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }

    // MARK: - Local fallback

    private static func localSession() -> MarketSession {
        let now = Date()
        let cal = Calendar.current
        let comps = cal.dateComponents(in: et, from: now)
        guard let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else { return .closed }

        if weekday == 1 || weekday == 7 { return .closed }
        if isMarketHoliday(date: now) { return .closed }

        let time = hour * 60 + minute
        if time >= 9 * 60 + 30 && time < 16 * 60 { return .regular }
        if time >= 4 * 60 && time < 9 * 60 + 30 { return .preMarket }
        if time >= 16 * 60 && time < 20 * 60 { return .postMarket }
        return .closed
    }

    // MARK: - Hardcoded holiday fallback

    private static let knownHolidays: Set<String> = [
        // 2025
        "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18",
        "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01",
        "2025-11-27", "2025-12-25",
        // 2026
        "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
        "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
        "2026-11-26", "2026-12-25",
    ]

    private static let holidayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = et
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
