import Foundation

enum AnalysisHistoryStore {
    private static let maxPerSymbol = 50
    private static let retentionDays = 90

    private static var historyDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("analysis_history", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Save an analysis result to history. Only call when AI analysis was generated.
    static func save(_ result: AnalysisResult) {
        // Skip if no AI analysis content
        guard !result.claudeAnalysis.isEmpty,
              !result.claudeAnalysis.contains("not configured") else { return }

        let url = historyDir.appendingPathComponent("\(result.symbol).json")
        var history = load(symbol: result.symbol)

        // Deduplicate: skip if we already have an entry within 60 seconds
        if let latest = history.first,
           abs(latest.timestamp.timeIntervalSince(result.timestamp)) < 60 {
            return
        }

        history.insert(result, at: 0)

        // Enforce retention policy
        let cutoff = Date().addingTimeInterval(-Double(retentionDays * 86400))
        history.removeAll { $0.timestamp < cutoff }

        // Cap total entries
        if history.count > maxPerSymbol { history = Array(history.prefix(maxPerSymbol)) }

        DispatchQueue.global(qos: .utility).async {
            if let data = try? JSONEncoder().encode(history) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    static func load(symbol: String) -> [AnalysisResult] {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        guard let data = try? Data(contentsOf: url),
              let history = try? JSONDecoder().decode([AnalysisResult].self, from: data)
        else { return [] }
        return history
    }

    static func delete(symbol: String, id: UUID) {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        var history = load(symbol: symbol)
        history.removeAll { $0.id == id }
        if let data = try? JSONEncoder().encode(history) {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func clearAll(symbol: String) {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        try? FileManager.default.removeItem(at: url)
    }
}
