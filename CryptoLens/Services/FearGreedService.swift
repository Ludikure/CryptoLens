import Foundation

/// Fetches historical Fear & Greed Index from Alternative.me.
/// Free API, no key required, daily data back to Feb 2018.
enum FearGreedService {

    struct FGEntry {
        let date: Date
        let value: Int  // 0-100
    }

    /// Fetch full history, return as date-indexed dict (start of day → value).
    static func fetchHistory() async -> [Date: Int] {
        guard let url = URL(string: "https://api.alternative.me/fng/?limit=0&format=json") else { return [:] }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entries = json["data"] as? [[String: Any]] else { return [:] }

            var result = [Date: Int]()
            let cal = Calendar.current
            for entry in entries {
                guard let valueStr = entry["value"] as? String,
                      let value = Int(valueStr),
                      let tsStr = entry["timestamp"] as? String,
                      let ts = Double(tsStr) else { continue }
                let date = cal.startOfDay(for: Date(timeIntervalSince1970: ts))
                result[date] = value
            }
            #if DEBUG
            print("[FearGreed] Fetched \(result.count) daily entries")
            #endif
            return result
        } catch {
            #if DEBUG
            print("[FearGreed] Fetch failed: \(error.localizedDescription)")
            #endif
            return [:]
        }
    }

    /// Convert 0-100 value to zone: -2=extreme fear, -1=fear, 0=neutral, 1=greed, 2=extreme greed
    static func zone(for value: Int) -> Int {
        if value <= 20 { return -2 }      // Extreme Fear
        if value <= 40 { return -1 }      // Fear
        if value <= 60 { return 0 }       // Neutral
        if value <= 80 { return 1 }       // Greed
        return 2                           // Extreme Greed
    }
}
