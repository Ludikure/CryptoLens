import Foundation

struct EconomicEvent: Codable, Identifiable {
    let id: UUID
    let title: String
    let date: Date
    let impact: String      // "High", "Medium", "Low"
    let country: String     // "USD", "EUR", etc.
    let forecast: String?
    let previous: String?

    init(title: String, date: Date, impact: String, country: String, forecast: String? = nil, previous: String? = nil) {
        self.id = UUID()
        self.title = title
        self.date = date
        self.impact = impact
        self.country = country
        self.forecast = forecast
        self.previous = previous
    }

    var isHighImpact: Bool { impact == "High" }
    var isWithin48Hours: Bool { date.timeIntervalSinceNow < 48 * 3600 && date.timeIntervalSinceNow > -3600 }
}
