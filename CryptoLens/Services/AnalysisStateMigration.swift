import Foundation
import SwiftData

/// One-time migration of kill duration and regime state from UserDefaults to SwiftData.
enum AnalysisStateMigration {
    static func migrateIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: "analysisStateMigrated") else { return }

        do {
            let container = try ModelContainer(for: AnalysisState.self)
            let context = ModelContext(container)

            let defaults = UserDefaults.standard
            let allKeys = defaults.dictionaryRepresentation().keys

            let symbols = Set(
                allKeys.filter { $0.hasPrefix("regime_") }
                    .map { String($0.dropFirst("regime_".count)) }
            )

            for symbol in symbols {
                let state = AnalysisState(symbol: symbol)
                state.lastRegime = defaults.string(forKey: "regime_\(symbol)") ?? ""
                if let dur = defaults.dictionary(forKey: "killDur_\(symbol)") as? [String: Int] {
                    state.divergenceDuration = dur["divergence"] ?? 0
                    state.volumeDuration = dur["volume"] ?? 0
                    state.fundingDuration = dur["funding"] ?? 0
                }
                state.lastUpdated = Date()
                context.insert(state)

                // Clean up old keys
                defaults.removeObject(forKey: "regime_\(symbol)")
                defaults.removeObject(forKey: "killDur_\(symbol)")
            }

            try context.save()
            defaults.set(true, forKey: "analysisStateMigrated")
            #if DEBUG
            print("[MarketScope] Migrated \(symbols.count) symbol states from UserDefaults to SwiftData")
            #endif
        } catch {
            #if DEBUG
            print("[MarketScope] AnalysisState migration failed: \(error)")
            #endif
        }
    }
}
