import Foundation

class EconomicCalendarService {
    private let session: URLSession
    private var cache: (events: [EconomicEvent], fetched: Date)?

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)
    }

    func fetchUpcomingEvents() async -> [EconomicEvent] {
        // Cache for 15 minutes (events can be added/rescheduled)
        if let cache = cache, Date().timeIntervalSince(cache.fetched) < 900 {
            return cache.events
        }

        guard let url = URL(string: "https://nfs.faireconomy.media/ff_calendar_thisweek.json") else { return [] }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }
            guard let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }

            let dateFormatter = ISO8601DateFormatter()
            dateFormatter.formatOptions = [.withInternetDateTime]

            var events = [EconomicEvent]()
            for item in array {
                guard let title = item["title"] as? String,
                      let dateStr = item["date"] as? String,
                      let impact = item["impact"] as? String,
                      let country = item["country"] as? String
                else { continue }

                // Try ISO8601 first, then manual parsing
                var date: Date?
                date = dateFormatter.date(from: dateStr)
                if date == nil {
                    // Try without timezone
                    let df = DateFormatter()
                    df.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
                    df.locale = Locale(identifier: "en_US_POSIX")
                    date = df.date(from: dateStr)
                }
                if date == nil {
                    let df = DateFormatter()
                    df.dateFormat = "MM-dd-yyyy HH:mm:ss"
                    df.locale = Locale(identifier: "en_US_POSIX")
                    df.timeZone = TimeZone(identifier: "America/New_York")
                    date = df.date(from: dateStr)
                }

                guard let eventDate = date else { continue }

                let forecast = item["forecast"] as? String
                let previous = item["previous"] as? String

                events.append(EconomicEvent(
                    title: title, date: eventDate, impact: impact,
                    country: country, forecast: forecast, previous: previous
                ))
            }

            // Sort by date, filter to upcoming only (within next 7 days, not past by more than 1 hour)
            let upcoming = events
                .filter { $0.date.timeIntervalSinceNow > -3600 }
                .sorted { $0.date < $1.date }

            cache = (upcoming, Date())
            return upcoming
        } catch {
            #if DEBUG
            print("[MarketScope] Economic calendar fetch failed: \(error)")
            #endif
            return []
        }
    }

    /// Get only high-impact events within the next 48 hours (for AI prompt)
    func highImpactUpcoming() async -> [EconomicEvent] {
        let events = await fetchUpcomingEvents()
        return events.filter { $0.isHighImpact && $0.isWithin48Hours }
    }
}
