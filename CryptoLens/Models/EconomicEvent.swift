import Foundation

struct EconomicEvent: Codable, Identifiable {
    let id: UUID
    let title: String
    let date: Date
    let impact: String      // "High", "Medium", "Low"
    let country: String     // "USD", "EUR", etc.
    let forecast: String?
    let previous: String?
    let actual: String?

    init(title: String, date: Date, impact: String, country: String, forecast: String? = nil, previous: String? = nil, actual: String? = nil) {
        self.id = UUID()
        self.title = title
        self.date = date
        self.impact = impact
        self.country = country
        self.forecast = forecast
        self.previous = previous
        self.actual = actual
    }

    var isHighImpact: Bool { impact == "High" }
    /// Event is upcoming (within next 48h)
    var isUpcoming: Bool { date.timeIntervalSinceNow > 0 && date.timeIntervalSinceNow < 48 * 3600 }
    /// Event was released recently (within past 12h)
    var isRecentlyReleased: Bool { date.timeIntervalSinceNow <= 0 && date.timeIntervalSinceNow > -12 * 3600 }
    /// Has actual data been published
    var hasActual: Bool { actual != nil && actual != "" }
    /// Beat/miss/meet vs forecast
    var surprise: String? {
        guard let act = actual, !act.isEmpty,
              let exp = forecast, !exp.isEmpty,
              let actVal = Double(act.replacingOccurrences(of: "%", with: "").replacingOccurrences(of: "K", with: "")),
              let expVal = Double(exp.replacingOccurrences(of: "%", with: "").replacingOccurrences(of: "K", with: ""))
        else { return nil }
        if actVal > expVal * 1.01 { return "BEAT" }
        if actVal < expVal * 0.99 { return "MISS" }
        return "IN-LINE"
    }
}
