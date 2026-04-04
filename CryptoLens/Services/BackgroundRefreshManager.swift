import Foundation
import BackgroundTasks

enum BackgroundRefreshManager {
    static let taskIdentifier = "com.ludikure.CryptoLens.priceCheck"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            handleRefresh(task: task)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 min
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            #if DEBUG
            print("[MarketScope] BG schedule failed: \(error)")
            #endif
        }
    }

    private static func handleRefresh(task: BGAppRefreshTask) {
        // Schedule next refresh
        schedule()

        let checkTask = Task {
            await checkPrices()
        }

        task.expirationHandler = {
            checkTask.cancel()
        }

        Task {
            await checkTask.value
            task.setTaskCompleted(success: true)
        }
    }

    private static func checkPrices() async {
        let store = await MainActor.run { AlertsStore() }
        let activeAlerts = await store.activeAlerts
        guard !activeAlerts.isEmpty else { return }

        // Get unique symbols that have active alerts
        let symbols = Set(activeAlerts.map(\.symbol))
        let binance = BinanceService()
        let yahoo = YahooFinanceService()
        var prices = [String: Double]()

        for symbol in symbols {
            do {
                if symbol.hasSuffix("USDT") {
                    // Crypto — use Binance
                    let candles = try await binance.fetchCandles(symbol: symbol, interval: "1m", limit: 1)
                    if let last = candles.last { prices[symbol] = last.close }
                } else {
                    // Stock — use Yahoo
                    let candles = try await yahoo.fetchCandles(symbol: symbol, interval: "1d", range: "1d")
                    if let last = candles.last { prices[symbol] = last.close }
                }
            } catch {
                // Skip failed fetches
            }
        }

        let fetchedPrices = prices
        await MainActor.run {
            // Capture alert IDs that are not yet triggered before checking
            let previouslyUntriggered = Set(store.activeAlerts.map { $0.id.uuidString })

            store.checkAlerts(prices: fetchedPrices)

            // Determine which alerts were just triggered
            let nowUntriggered = Set(store.activeAlerts.map { $0.id.uuidString })
            let newlyTriggered = previouslyUntriggered.subtracting(nowUntriggered)

            if !newlyTriggered.isEmpty {
                // Append to any existing pending IDs (in case multiple BG runs fire)
                var pending = UserDefaults.standard.stringArray(forKey: Self.backgroundTriggeredKey) ?? []
                pending.append(contentsOf: newlyTriggered)
                UserDefaults.standard.set(pending, forKey: Self.backgroundTriggeredKey)
            }
        }
    }

    /// UserDefaults key for alert IDs triggered during background refresh.
    static let backgroundTriggeredKey = "backgroundTriggeredAlertIDs"
}
