import Foundation

class EconomicCalendarService {
    private let session: URLSession
    private var cache: (events: [EconomicEvent], fetched: Date)?
    private var blsCache: (actuals: [String: String], fetched: Date)?

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)
    }

    func fetchUpcomingEvents() async -> [EconomicEvent] {
        // Cache 5 minutes to pick up actuals faster
        if let cache = cache, Date().timeIntervalSince(cache.fetched) < 300 {
            return cache.events
        }

        async let fairEconomy = fetchFairEconomy()
        async let blsActuals = fetchBLSActuals()

        var events = await fairEconomy
        let actuals = await blsActuals

        // Merge BLS actuals into released events that are missing actuals
        if !actuals.isEmpty {
            let today = Calendar.current.startOfDay(for: Date())
            // Sort keys longest first so "Core CPI m/m" matches before "CPI m/m"
            let sortedKeys = actuals.keys.sorted { $0.count > $1.count }
            events = events.map { event in
                guard !event.hasActual, event.country == "USD",
                      event.date < Date(),  // already released
                      event.date >= today    // released today
                else { return event }
                guard let key = sortedKeys.first(where: { event.title.localizedCaseInsensitiveContains($0) }),
                      let actual = actuals[key]
                else { return event }
                return EconomicEvent(
                    title: event.title, date: event.date, impact: event.impact,
                    country: event.country, forecast: event.forecast,
                    previous: event.previous, actual: actual
                )
            }
        }

        // Keep events released today or upcoming
        let relevant = events
            .filter { $0.isRecentlyReleased || $0.isUpcoming || $0.date.timeIntervalSinceNow > 0 }
            .sorted { $0.date < $1.date }

        #if DEBUG
        let highImpact = relevant.filter { $0.isHighImpact }
        print("[MarketScope] Calendar: \(events.count) total → \(relevant.count) relevant (\(highImpact.count) high-impact)")
        for e in highImpact.prefix(3) {
            print("[MarketScope]   \(e.title): released=\(e.isRecentlyReleased) upcoming=\(e.isUpcoming) actual=\(e.actual ?? "nil")")
        }
        #endif

        // Only cache non-empty results to avoid poisoning from startup network failures
        if !relevant.isEmpty {
            cache = (relevant, Date())
        }
        return relevant
    }

    func highImpactRelevant() async -> [EconomicEvent] {
        let events = await fetchUpcomingEvents()
        return events.filter { $0.isHighImpact && ($0.isUpcoming || $0.isRecentlyReleased) }
    }

    // MARK: - FairEconomy

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
            print("[MarketScope] Economic calendar fetch failed: \(error)")
            #endif
            return []
        }
    }

    // MARK: - BLS Actuals

    private func fetchBLSActuals() async -> [String: String] {
        // Cache BLS for 1 hour (data only updates monthly)
        if let cache = blsCache, Date().timeIntervalSince(cache.fetched) < 3600 {
            return cache.actuals
        }

        guard let url = URL(string: "\(PushService.workerURL)/bls/actuals") else { return [:] }
        var request = URLRequest(url: url)
        request.setValue("marketscope-ios", forHTTPHeaderField: "X-App-ID")

        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode)
        else {
            #if DEBUG
            print("[MarketScope] BLS actuals: fetch failed")
            #endif
            return [:]
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let actuals = json["actuals"] as? [String: String]
        else { return [:] }

        #if DEBUG
        print("[MarketScope] BLS actuals: \(actuals.count) series (\(actuals))")
        #endif

        if !actuals.isEmpty {
            blsCache = (actuals, Date())
        }
        return actuals
    }
}
