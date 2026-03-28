import Foundation

enum AnalysisHistoryStore {
    private static var historyDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("analysis_history", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func save(_ result: AnalysisResult) {
        let url = historyDir.appendingPathComponent("\(result.symbol).json")
        var history = load(symbol: result.symbol)
        history.insert(result, at: 0)
        if history.count > 5 { history = Array(history.prefix(5)) }
        if let data = try? JSONEncoder().encode(history) {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func load(symbol: String) -> [AnalysisResult] {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        guard let data = try? Data(contentsOf: url),
              let history = try? JSONDecoder().decode([AnalysisResult].self, from: data)
        else { return [] }
        return history
    }
}
