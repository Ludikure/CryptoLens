import Foundation

enum CandleCache {
    private static var cacheDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("candle_cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func loadOrFetch(symbol: String, interval: String, startDate: Date, endDate: Date,
                             fetcher: (String, String, Date, Date) async throws -> [Candle]) async throws -> [Candle] {
        let cal = Calendar.current
        let startYear = cal.component(.year, from: startDate)
        let endYear = cal.component(.year, from: endDate)
        var allCandles = [Candle]()
        for year in startYear...endYear {
            let key = "\(symbol)_\(interval)_\(year)"
            let url = cacheDir.appendingPathComponent("\(key).json")
            if let cached = loadFromDisk(url: url) {
                allCandles.append(contentsOf: cached.filter { $0.time >= startDate && $0.time <= endDate })
                continue
            }
            let yearStart = cal.date(from: DateComponents(year: year, month: 1, day: 1))!
            let yearEnd = min(cal.date(from: DateComponents(year: year + 1, month: 1, day: 1))!, endDate)
            let fetched = try await fetcher(symbol, interval, yearStart, yearEnd)
            saveToDisk(candles: fetched, url: url)
            allCandles.append(contentsOf: fetched.filter { $0.time >= startDate && $0.time <= endDate })
        }
        var seen = Set<TimeInterval>()
        allCandles = allCandles.filter { seen.insert($0.time.timeIntervalSince1970).inserted }
        allCandles.sort { $0.time < $1.time }
        return allCandles
    }

    static var totalCacheSize: String {
        let files = (try? FileManager.default.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        let bytes = files.compactMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }.reduce(0, +)
        if bytes < 1_000_000 { return "\(bytes / 1_000) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }

    static func clearAll() { try? FileManager.default.removeItem(at: cacheDir) }

    /// Stitch together 1H stock candles from multiple providers for maximum history.
    /// Twelve Data: up to 5000 candles (~2.8yr) per request. Yahoo: recent 2 years.
    /// Alpha Vantage: remaining gaps (month-by-month, slow).
    /// Deduplicates by timestamp, caches the stitched result permanently.
    static func loadOrFetchStitched(symbol: String, startDate: Date, endDate: Date,
                                     yahoo: YahooFinanceService,
                                     alphaVantage: AlphaVantageProvider,
                                     twelveData: TwelveDataProvider? = nil) async throws -> [Candle] {
        let key = "\(symbol)_1h_stitched"
        let url = cacheDir.appendingPathComponent("\(key).json")

        // Check if we already have a stitched cache that covers the requested range
        if let cached = loadFromDisk(url: url) {
            let filtered = cached.filter { $0.time >= startDate && $0.time <= endDate }
            let coversStart = cached.contains { $0.time <= startDate }
            if filtered.count >= 100 && coversStart {
                #if DEBUG
                print("[CandleCache] \(symbol) stitched: \(filtered.count) from cache")
                #endif
                return filtered
            }
            #if DEBUG
            print("[CandleCache] \(symbol) cache exists (\(cached.count)) but doesn't cover start \(startDate) — re-fetching")
            #endif
        }

        var allCandles = [Candle]()

        // Layer 1: Yahoo — recent 2 years (fast, no rate limit)
        let twoYearsAgo = Calendar.current.date(byAdding: .year, value: -2, to: endDate)!
        let yahooStart = max(startDate, twoYearsAgo)
        do {
            let yahooCandles = try await yahoo.fetchHistoricalCandles(
                symbol: symbol, interval: "1h", startDate: yahooStart, endDate: endDate)
            allCandles.append(contentsOf: yahooCandles)
            #if DEBUG
            print("[CandleCache] \(symbol) Yahoo 1H: \(yahooCandles.count) candles")
            #endif
        } catch {
            #if DEBUG
            print("[CandleCache] \(symbol) Yahoo 1H fetch failed: \(error.localizedDescription)")
            #endif
        }

        // Layer 2: Twelve Data — up to 5000 candles per request (~2.8yr), fills pre-Yahoo gap
        if startDate < yahooStart, let td = twelveData {
            // Split into chunks of ~2.5 years to stay within 5000 candle limit
            let chunkDays = 2 * 365  // ~2 years per chunk (conservative)
            var chunkEnd = yahooStart
            while chunkEnd > startDate {
                let chunkStart = max(startDate, Calendar.current.date(byAdding: .day, value: -chunkDays, to: chunkEnd)!)
                do {
                    let tdCandles = try await td.fetchHistoricalCandles(
                        symbol: symbol, interval: "1h", startDate: chunkStart, endDate: chunkEnd)
                    allCandles.append(contentsOf: tdCandles)
                    #if DEBUG
                    print("[CandleCache] \(symbol) TwelveData 1H: \(tdCandles.count) candles (\(chunkStart) → \(chunkEnd))")
                    #endif
                } catch {
                    #if DEBUG
                    print("[CandleCache] \(symbol) TwelveData 1H fetch failed: \(error.localizedDescription)")
                    #endif
                }
                chunkEnd = chunkStart
                // Respect 8 req/min rate limit
                try? await Task.sleep(nanoseconds: 8_000_000_000)
            }
        }

        // Layer 3: Alpha Vantage — anything still missing (month-by-month, slowest)
        let earliestSoFar = allCandles.map(\.time).min() ?? endDate
        if startDate < earliestSoFar {
            do {
                let avCandles = try await alphaVantage.fetchHistoricalCandles(
                    symbol: symbol, startDate: startDate, endDate: earliestSoFar)
                allCandles.append(contentsOf: avCandles)
                #if DEBUG
                print("[CandleCache] \(symbol) Alpha Vantage 1H: \(avCandles.count) candles (pre-TwelveData range)")
                #endif
            } catch {
                #if DEBUG
                print("[CandleCache] \(symbol) Alpha Vantage 1H fetch failed: \(error.localizedDescription)")
                #endif
            }
        }

        // Deduplicate by timestamp
        var seen = Set<TimeInterval>()
        allCandles = allCandles.filter { seen.insert($0.time.timeIntervalSince1970).inserted }
        allCandles.sort { $0.time < $1.time }

        // Cache the stitched result
        if !allCandles.isEmpty {
            saveToDisk(candles: allCandles, url: url)
        }

        #if DEBUG
        if let first = allCandles.first, let last = allCandles.last {
            let days = Int(last.time.timeIntervalSince(first.time) / 86400)
            print("[CandleCache] \(symbol) stitched total: \(allCandles.count) candles, \(days) days")
        }
        #endif

        return allCandles.filter { $0.time >= startDate && $0.time <= endDate }
    }

    private static func loadFromDisk(url: URL) -> [Candle]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([Candle].self, from: data)
    }

    private static func saveToDisk(candles: [Candle], url: URL) {
        guard let data = try? JSONEncoder().encode(candles) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
