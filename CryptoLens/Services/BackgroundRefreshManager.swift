import Foundation
import BackgroundTasks

enum BackgroundRefreshManager {
    static let taskIdentifier = "com.ludikure.MarketScope.priceCheck"

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
            print("[MarketScope] BG schedule failed: \(error)")
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
        let store = AlertsStore()
        let activeAlerts = store.activeAlerts
        guard !activeAlerts.isEmpty else { return }

        // Get unique symbols that have active alerts
        let symbols = Set(activeAlerts.map(\.symbol))
        let binance = BinanceService()
        var prices = [String: Double]()

        for symbol in symbols {
            do {
                let candles = try await binance.fetchCandles(symbol: symbol, interval: "1m", limit: 1)
                if let last = candles.last {
                    prices[symbol] = last.close
                }
            } catch {
                // Skip failed fetches
            }
        }

        store.checkAlerts(prices: prices)
    }
}
