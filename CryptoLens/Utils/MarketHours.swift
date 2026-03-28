import Foundation

enum MarketSession: String {
    case preMarket = "Pre-Market"
    case regular = "Market Open"
    case postMarket = "After Hours"
    case closed = "Market Closed"
}

enum MarketHours {
    private static let et = TimeZone(identifier: "America/New_York")!

    static func currentSession() -> MarketSession {
        let cal = Calendar.current
        let comps = cal.dateComponents(in: et, from: Date())
        guard let weekday = comps.weekday, let hour = comps.hour, let minute = comps.minute else { return .closed }

        // Weekend
        if weekday == 1 || weekday == 7 { return .closed }

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
        var comps = cal.dateComponents(in: et, from: now)
        guard let weekday = comps.weekday else { return nil }

        // Find next weekday 9:30 AM ET
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

        comps.day = (comps.day ?? 0) + daysToAdd
        comps.hour = 9
        comps.minute = 30
        comps.second = 0

        guard let nextOpen = cal.date(from: comps) else { return nil }
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
