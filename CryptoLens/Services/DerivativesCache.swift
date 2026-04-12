import Foundation

/// Caches historical derivatives data per symbol to disk.
enum DerivativesCache {
    private static var cacheDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("derivatives_cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func loadOrFetch(symbol: String, startDate: Date, endDate: Date) async -> [Date: HistoricalDerivativesService.DerivativesBar] {
        let key = "\(symbol)_derivatives"
        let url = cacheDir.appendingPathComponent("\(key).json")

        // Try cache first — validate it covers the requested date range
        if let data = try? Data(contentsOf: url),
           let cached = try? JSONDecoder().decode([String: HistoricalDerivativesService.DerivativesBar].self, from: data) {
            var result = [Date: HistoricalDerivativesService.DerivativesBar]()
            for (_, bar) in cached { result[bar.timestamp] = bar }
            let filtered = result.filter { $0.key >= startDate && $0.key <= endDate }
            // Expect roughly 1 bar per 4H — require at least 25% coverage
            let expectedBars = Int(endDate.timeIntervalSince(startDate) / (4 * 3600))
            let minRequired = max(100, expectedBars / 4)
            if filtered.count >= minRequired {
                #if DEBUG
                print("[DerivativesCache] \(symbol): \(filtered.count) bars from cache (need \(minRequired))")
                #endif
                return filtered
            }
            #if DEBUG
            print("[DerivativesCache] \(symbol): cache too sparse (\(filtered.count)/\(minRequired)), refetching")
            #endif
        }

        // Fetch fresh
        let fetched = await HistoricalDerivativesService.fetch(symbol: symbol, startDate: startDate, endDate: endDate)

        // Cache to disk
        if !fetched.isEmpty {
            let encodable = Dictionary(uniqueKeysWithValues: fetched.map {
                (String($0.key.timeIntervalSince1970), $0.value)
            })
            if let data = try? JSONEncoder().encode(encodable) {
                try? data.write(to: url, options: .atomic)
            }
        }

        #if DEBUG
        print("[DerivativesCache] \(symbol): \(fetched.count) bars fetched")
        #endif

        return fetched
    }

    static func clearAll() {
        try? FileManager.default.removeItem(at: cacheDir)
    }
}
