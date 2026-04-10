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

        // Fetch from both sources in parallel
        async let fairEconomy = fetchFairEconomy()
        async let finnhubActuals = fetchFinnhubActuals()

        var events = await fairEconomy
        let actuals = await finnhubActuals

        // Merge Finnhub actuals into FairEconomy events
        if !actuals.isEmpty {
            events = mergeActuals(events: events, finnhub: actuals)
        }

        // Keep events upcoming or recently released (past 12h) so the LLM sees actual numbers
        let relevant = events
            .filter { $0.date.timeIntervalSinceNow > -12 * 3600 }
            .sorted { $0.date < $1.date }

        cache = (relevant, Date())
        return relevant
    }

    /// Get high-impact events: upcoming (next 48h) or recently released (past 12h) for AI prompt
    func highImpactRelevant() async -> [EconomicEvent] {
        let events = await fetchUpcomingEvents()
        return events.filter { $0.isHighImpact && ($0.isUpcoming || $0.isRecentlyReleased) }
    }

    // MARK: - FairEconomy (event names + timing)

    private func fetchFairEconomy() async -> [EconomicEvent] {
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

                var date: Date?
                date = dateFormatter.date(from: dateStr)
                if date == nil {
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
                let actual = item["actual"] as? String

                events.append(EconomicEvent(
                    title: title, date: eventDate, impact: impact,
                    country: country, forecast: forecast, previous: previous, actual: actual
                ))
            }
            return events
        } catch is CancellationError {
            return []
        } catch let error as NSError where error.code == NSURLErrorCancelled {
            return []
        } catch {
            #if DEBUG
            print("[MarketScope] FairEconomy fetch failed: \(error)")
            #endif
            return []
        }
    }

    // MARK: - Finnhub (actuals)

    private struct FinnhubEconEvent {
        let event: String
        let country: String
        let time: Date
        let actual: Double?
        let estimate: Double?
        let prev: Double?
        let unit: String
    }

    private func fetchFinnhubActuals() async -> [FinnhubEconEvent] {
        await PushService.ensureAuth()
        guard let url = URL(string: "\(PushService.workerURL)/finnhub/economic-calendar") else { return [] }
        var request = URLRequest(url: url)
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode)
        else { return [] }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calendar = json["economicCalendar"] as? [[String: Any]]
        else { return [] }

        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(abbreviation: "UTC")

        var results = [FinnhubEconEvent]()
        for item in calendar {
            guard let event = item["event"] as? String,
                  let country = item["country"] as? String,
                  let timeStr = item["time"] as? String,
                  let time = df.date(from: timeStr)
            else { continue }

            let actual = item["actual"] as? Double
            let estimate = item["estimate"] as? Double
            let prev = item["prev"] as? Double
            let unit = item["unit"] as? String ?? ""

            // Only keep events that have actuals
            guard actual != nil else { continue }

            results.append(FinnhubEconEvent(
                event: event, country: country, time: time,
                actual: actual, estimate: estimate, prev: prev, unit: unit
            ))
        }

        #if DEBUG
        print("[MarketScope] Finnhub economic calendar: \(results.count) events with actuals")
        #endif
        return results
    }

    // MARK: - Merge

    private func mergeActuals(events: [EconomicEvent], finnhub: [FinnhubEconEvent]) -> [EconomicEvent] {
        events.map { event in
            // Skip if already has actual
            guard !event.hasActual else { return event }

            // Find matching Finnhub event: same country, same day, similar name
            let eventDay = Calendar.current.startOfDay(for: event.date)
            let match = finnhub.first { fh in
                guard fh.country == event.country else { return false }
                let fhDay = Calendar.current.startOfDay(for: fh.time)
                guard fhDay == eventDay else { return false }
                // Fuzzy match: check if key words overlap
                let eventWords = Set(event.title.lowercased().split(separator: " ").map(String.init))
                let fhWords = Set(fh.event.lowercased().split(separator: " ").map(String.init))
                let overlap = eventWords.intersection(fhWords)
                return overlap.count >= 2 || fh.event.lowercased().contains(event.title.lowercased().prefix(10))
            }

            guard let m = match, let actual = m.actual else { return event }

            let actualStr: String
            if m.unit == "%" {
                actualStr = String(format: "%.1f%%", actual)
            } else if abs(actual) >= 1000 {
                actualStr = String(format: "%.1fK", actual / 1000)
            } else {
                actualStr = String(format: "%.1f", actual)
            }

            return EconomicEvent(
                title: event.title, date: event.date, impact: event.impact,
                country: event.country, forecast: event.forecast,
                previous: event.previous, actual: actualStr
            )
        }
    }
}
