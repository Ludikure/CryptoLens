import Foundation

enum AnalysisHistoryStore {
    private static let maxPerSymbol = 50
    private static let retentionDays = 90
    private static let ioQueue = DispatchQueue(label: "com.ludikure.CryptoLens.historyIO")

    private static var historyDir: URL {
        PersistentStore.directory(named: "analysis_history")
    }

    /// Save an analysis result to history. Only call when AI analysis was generated.
    static func save(_ result: AnalysisResult) {
        // Skip if no AI analysis content
        guard !result.claudeAnalysis.isEmpty,
              !result.claudeAnalysis.contains("not configured") else { return }

        ioQueue.async {
            let url = historyDir.appendingPathComponent("\(result.symbol).json")
            var history = loadSync(url: url)

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

            if let data = try? JSONEncoder().encode(history) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    static func load(symbol: String) -> [AnalysisResult] {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        return ioQueue.sync { loadSync(url: url) }
    }

    /// Non-blocking async variant — use from UI contexts to avoid blocking main thread.
    static func loadAsync(symbol: String) async -> [AnalysisResult] {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let url = historyDir.appendingPathComponent("\(symbol).json")
                let result = loadSync(url: url)
                continuation.resume(returning: result)
            }
        }
    }

    static func delete(symbol: String, id: UUID) {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        ioQueue.sync {
            var history = loadSync(url: url)
            history.removeAll { $0.id == id }
            if let data = try? JSONEncoder().encode(history) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    /// Non-blocking async variant — use from UI contexts (swipe-to-delete) to avoid
    /// hitching the main thread on disk I/O.
    static func deleteAsync(symbol: String, id: UUID) async {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let url = historyDir.appendingPathComponent("\(symbol).json")
                var history = loadSync(url: url)
                history.removeAll { $0.id == id }
                if let data = try? JSONEncoder().encode(history) {
                    try? data.write(to: url, options: .atomic)
                }
                continuation.resume()
            }
        }
    }

    static func clearAll(symbol: String) {
        let url = historyDir.appendingPathComponent("\(symbol).json")
        ioQueue.sync {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Non-blocking async variant — use from UI contexts to avoid blocking main thread.
    static func clearAllAsync(symbol: String) async {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let url = historyDir.appendingPathComponent("\(symbol).json")
                try? FileManager.default.removeItem(at: url)
                continuation.resume()
            }
        }
    }

    /// Internal unsynchronized read — must be called on ioQueue.
    private static func loadSync(url: URL) -> [AnalysisResult] {
        guard let data = try? Data(contentsOf: url),
              let history = try? JSONDecoder().decode([AnalysisResult].self, from: data)
        else { return [] }
        return history
    }
}


/// Where the app keeps data it CANNOT regenerate.
///
/// Analyses and their history used to live in `.cachesDirectory` — which iOS purges whenever the
/// device comes under storage pressure, with no warning and no way to opt out. That is correct for
/// something re-downloadable and wrong for these: an LLM analysis cost real money, describes a bar
/// that has already passed, and can never be reproduced. Losing it is the "my latest analysis
/// disappeared after a while" report. Application Support is the documented home for exactly this
/// (app-owned data the user would miss, not user-facing documents).
///
/// Existing files are MOVED on first access, so nothing that survived the last purge is lost.
enum PersistentStore {
    static func directory(named name: String) -> URL {
        let fm = FileManager.default
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent(name, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        migrateFromCachesIfNeeded(name: name, into: dir, fm: fm)
        return dir
    }

    /// One-shot: relocate anything the system hasn't already evicted. Keyed per directory so it
    /// runs once, not on every access.
    private static func migrateFromCachesIfNeeded(name: String, into dir: URL, fm: FileManager) {
        let flag = "migrated_from_caches_\(name)"
        guard !UserDefaults.standard.bool(forKey: flag) else { return }
        UserDefaults.standard.set(true, forKey: flag)
        guard let old = fm.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(name, isDirectory: true),
              let files = try? fm.contentsOfDirectory(at: old, includingPropertiesForKeys: nil) else { return }
        for f in files {
            let dest = dir.appendingPathComponent(f.lastPathComponent)
            if !fm.fileExists(atPath: dest.path) { try? fm.moveItem(at: f, to: dest) }
        }
        try? fm.removeItem(at: old)
    }
}
