import Foundation

enum MarketSession: String {
    case preMarket = "Pre-Market"
    case regular = "Market Open"
    case postMarket = "After Hours"
    case closed = "Market Closed"
}

enum MarketHours {
    private static let et = TimeZone(identifier: "America/New_York")!

    // MARK: - NYSE/NASDAQ Holiday Calendar (2025-2026)

    /// Fixed and observed holidays for NYSE/NASDAQ.
    /// Dates follow the exchange calendar: when a holiday falls on Saturday it is
    /// observed the preceding Friday; when it falls on Sunday it is observed the
    /// following Monday.
    private static let holidays: Set<String> = {
        // Format: "yyyy-MM-dd" in Eastern Time
        return [
            // 2025
            "2025-01-01", // New Year's Day
            "2025-01-20", // MLK Day (3rd Monday Jan)
            "2025-02-17", // Presidents' Day (3rd Monday Feb)
            "2025-04-18", // Good Friday
            "2025-05-26", // Memorial Day (last Monday May)
            "2025-06-19", // Juneteenth
            "2025-07-04", // Independence Day
            "2025-09-01", // Labor Day (1st Monday Sep)
            "2025-11-27", // Thanksgiving (4th Thursday Nov)
            "2025-12-25", // Christmas

            // 2026
            "2026-01-01", // New Year's Day
            "2026-01-19", // MLK Day
            "2026-02-16", // Presidents' Day
            "2026-04-03", // Good Friday
            "2026-05-25", // Memorial Day
            "2026-06-19", // Juneteenth
            "2026-07-03", // Independence Day (observed, Jul 4 is Saturday)
            "2026-09-07", // Labor Day
            "2026-11-26", // Thanksgiving
            "2026-12-25", // Christmas
        ]
    }()

    private static let holidayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = et
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Returns true if the given date falls on an NYSE/NASDAQ holiday.
    static func isMarketHoliday(date: Date = Date()) -> Bool {
        let key = holidayFormatter.string(from: date)
        return holidays.contains(key)
    }

    static func currentSession() -> MarketSession {
        let now = Date()
        let cal = Calendar.current
        let comps = cal.dateComponents(in: et, from: now)
        guard let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else { return .closed }

        // Weekend
        if weekday == 1 || weekday == 7 { return .closed }

        // Holiday
        if isMarketHoliday(date: now) { return .closed }

        let time = hour * 60 + minute
        let preOpen = 4 * 60        // 4:00 AM
        let regOpen = 9 * 60 + 30   // 9:30 AM
        let regClose = 16 * 60      // 4:00 PM
        let postClose = 20 * 60     // 8:00 PM

        if time >= regOpen && time < regClose { return .regular }
        if time >= preOpen && time < regOpen { return .preMarket }
        if time >= regClose && time < postClose { return .postMarket }
        return .closed
    }

    static func isMarketOpen() -> Bool {
        currentSession() == .regular
    }

    /// Time until next regular session open.
    static func timeToNextOpen() -> String? {
        let session = currentSession()
        if session == .regular { return nil }

        let cal = Calendar.current
        let now = Date()
        let comps = cal.dateComponents(in: et, from: now)
        guard let weekday = comps.weekday else { return nil }

        // Find next weekday 9:30 AM ET, skipping holidays
        var daysToAdd = 0
        if session == .preMarket {
            daysToAdd = 0 // Today
        } else if weekday == 6 { // Friday after close
            daysToAdd = 2
        } else if weekday == 7 { // Saturday
            daysToAdd = 2
        } else if weekday == 1 { // Sunday
            daysToAdd = 1
        } else {
            daysToAdd = 1 // Next day
        }

        guard let baseDate = cal.date(from: comps) else { return nil }
        guard var targetDay = cal.date(byAdding: .day, value: daysToAdd, to: baseDate) else { return nil }

        // Skip over any holidays (and weekends just in case)
        var safety = 0
        while isMarketHoliday(date: targetDay) && safety < 10 {
            guard let next = cal.date(byAdding: .day, value: 1, to: targetDay) else { break }
            targetDay = next
            // Also skip weekends
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

    /// Time until regular session close.
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
}
