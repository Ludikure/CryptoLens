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

    private static func loadFromDisk(url: URL) -> [Candle]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([Candle].self, from: data)
    }

    private static func saveToDisk(candles: [Candle], url: URL) {
        guard let data = try? JSONEncoder().encode(candles) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
