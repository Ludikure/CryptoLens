import Foundation

/// Tracks trade setup outcomes and FLAT/kill outcomes across refresh cycles.
/// Persists to disk alongside analysis history.
enum OutcomeTracker {
    private static let ioQueue = DispatchQueue(label: "com.ludikure.CryptoLens.outcomeIO")

    private static var outcomeDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("trade_outcomes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - Trade Setup Outcomes (#1b)

    /// Called during each refresh cycle with current price and recent candles.
    /// Scans ALL candles to catch every wick between refreshes.
    static func trackSetupOutcomes(symbol: String, currentPrice: Double,
                                    recentCandles: [Candle] = []) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            var tracked = loadTrackedSetups(url: url)
            var changed = false

            // Build price check points with open for same-candle heuristic
            struct PricePoint { let open: Double; let high: Double; let low: Double; let time: Date }
            var checkPoints = recentCandles.map { PricePoint(open: $0.open, high: $0.high, low: $0.low, time: $0.time) }
            checkPoints.append(PricePoint(open: currentPrice, high: currentPrice, low: currentPrice, time: Date()))

            for i in tracked.indices {
                guard !tracked[i].outcome.resolved else { continue }

                let setup = tracked[i].setup
                let isLong = setup.direction == "LONG"
                let setupTime = tracked[i].timestamp
                // If TP1 was already hit (from previous refresh), stop is at breakeven
                var activeStop = tracked[i].outcome.tp1Hit ? setup.entry : setup.stopLoss

                // Only check candles AFTER setup was registered
                let relevantPoints = checkPoints.filter { $0.time >= setupTime }

                for point in relevantPoints {
                    // Check entry hit
                    if !tracked[i].outcome.entryHit {
                        let entryHit = isLong ? point.low <= setup.entry : point.high >= setup.entry
                        if entryHit {
                            tracked[i].outcome.entryHit = true
                            tracked[i].outcome.entryHitTime = point.time
                            changed = true
                        }
                        continue
                    }

                    // Skip candles before entry
                    if let entryTime = tracked[i].outcome.entryHitTime, point.time < entryTime {
                        continue
                    }

                    // Track excursions
                    let favorable = isLong ? point.high - setup.entry : setup.entry - point.low
                    let adverse = isLong ? setup.entry - point.low : point.high - setup.entry
                    if favorable > tracked[i].outcome.maxFavorable {
                        tracked[i].outcome.maxFavorable = favorable; changed = true
                    }
                    if adverse > tracked[i].outcome.maxAdverse {
                        tracked[i].outcome.maxAdverse = adverse; changed = true
                    }

                    // Once resolved, only track excursions
                    if tracked[i].outcome.resolved { continue }

                    // Check stop and TP1 with open-proximity heuristic
                    let stopHit = isLong ? point.low <= activeStop : point.high >= activeStop
                    let tp1Hit = isLong ? point.high >= setup.tp1 : point.low <= setup.tp1

                    if stopHit && tp1Hit && !tracked[i].outcome.tp1Hit {
                        // Same-candle ambiguity: closer to open hits first
                        let distToStop = abs(point.open - activeStop)
                        let distToTP1 = abs(point.open - setup.tp1)
                        if distToStop <= distToTP1 {
                            tracked[i].outcome.stopHit = true
                            tracked[i].outcome.outcomeTime = point.time
                            changed = true; break
                        } else {
                            tracked[i].outcome.tp1Hit = true
                            activeStop = setup.entry  // Move stop to breakeven
                            changed = true
                        }
                    } else if stopHit {
                        tracked[i].outcome.stopHit = true
                        tracked[i].outcome.outcomeTime = point.time
                        changed = true; break
                    } else if tp1Hit && !tracked[i].outcome.tp1Hit {
                        tracked[i].outcome.tp1Hit = true
                        activeStop = setup.entry  // Move stop to breakeven
                        changed = true
                    }

                    // Check TP2
                    if let tp2 = setup.tp2, !tracked[i].outcome.tp2Hit {
                        let hit = isLong ? point.high >= tp2 : point.low <= tp2
                        if hit {
                            tracked[i].outcome.tp2Hit = true
                            tracked[i].outcome.outcomeTime = point.time
                            changed = true; break
                        }
                    }
                }
            }

            // Expire setups older than 7 days that never triggered
            let cutoff = Date().addingTimeInterval(-7 * 86400)
            let before = tracked.count
            tracked.removeAll { !$0.outcome.entryHit && $0.timestamp < cutoff }
            if tracked.count != before { changed = true }

            if changed { save(tracked, to: url) }
        }
    }

    /// Register a new setup for tracking.
    static func registerSetup(_ setup: TradeSetup, symbol: String, analysisId: UUID,
                              mlProbability: Double? = nil, conviction: String? = nil,
                              modelVersion: Int = 10) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            var tracked = loadTrackedSetups(url: url)

            // Don't duplicate
            guard !tracked.contains(where: { $0.setup.id == setup.id }) else { return }

            tracked.insert(TrackedSetup(setup: setup, symbol: symbol, analysisId: analysisId,
                                        mlProbability: mlProbability, conviction: conviction,
                                        modelVersion: modelVersion), at: 0)

            // Cap at 50 per symbol
            if tracked.count > 50 { tracked = Array(tracked.prefix(50)) }

            save(tracked, to: url)
        }
    }

    /// Sync resolved outcomes to the worker (D1) for cross-device tracking.
    static func syncResolvedOutcomes(symbol: String) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            let tracked = loadTrackedSetups(url: url)
            let resolved = tracked.filter { $0.outcome.resolved && !$0.synced }

            guard !resolved.isEmpty else { return }

            Task {
                await PushService.ensureAuth()
                for t in resolved {
                    guard let endpoint = URL(string: "\(PushService.workerURL)/outcomes") else { continue }
                    var request = URLRequest(url: endpoint)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    PushService.addAuthHeaders(&request)

                    let payload: [String: Any] = [
                        "symbol": t.symbol,
                        "direction": t.setup.direction,
                        "entry": t.setup.entry,
                        "stopLoss": t.setup.stopLoss,
                        "tp1": t.setup.tp1,
                        "tp2": t.setup.tp2 as Any,
                        "outcome": t.outcome.result,
                        "pnlPercent": 0,
                        "mlProb": t.mlProbability ?? 0,
                        "conviction": t.conviction ?? "",
                        "modelVersion": t.modelVersion,
                    ]
                    request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
                    _ = try? await URLSession.shared.data(for: request)
                }

                // Mark as synced
                ioQueue.async {
                    var all = loadTrackedSetups(url: url)
                    for i in all.indices where resolved.contains(where: { $0.setup.id == all[i].setup.id }) {
                        all[i].synced = true
                    }
                    save(all, to: url)
                }
            }
        }
    }

    // MARK: - FLAT/Kill Outcomes (#1c)

    /// Register a FLAT or kill-blocked outcome for tracking.
    static func registerFlatOutcome(symbol: String, price: Double, reason: String) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("flats_\(symbol).json")
            var flats = loadFlatOutcomes(url: url)

            flats.insert(FlatOutcome(symbol: symbol, price: price, reason: reason), at: 0)

            // Cap at 50
            if flats.count > 50 { flats = Array(flats.prefix(50)) }

            save(flats, to: url)
        }
    }

    /// Called during refresh to track price movement after FLAT decisions.
    static func trackFlatOutcomes(symbol: String, currentPrice: Double) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("flats_\(symbol).json")
            var flats = loadFlatOutcomes(url: url)
            var changed = false

            for i in flats.indices {
                guard flats[i].falseFlat == nil, flats[i].refreshCount < 3 else { continue }

                flats[i].refreshCount += 1
                changed = true

                if flats[i].refreshCount >= 3 {
                    flats[i].priceAfter3Refreshes = currentPrice
                    let move = abs(currentPrice - flats[i].priceAtFlat) / flats[i].priceAtFlat * 100
                    flats[i].falseFlat = move > 1.5
                    changed = true
                }
            }

            // Expire old entries (30 days)
            let cutoff = Date().addingTimeInterval(-30 * 86400)
            let before = flats.count
            flats.removeAll { $0.timestamp < cutoff }
            if flats.count != before { changed = true }

            if changed { save(flats, to: url) }
        }
    }

    // MARK: - Stats (#1d)

    /// Compute outcome statistics for dashboard.
    static func stats(symbol: String? = nil) -> OutcomeStats {
        return ioQueue.sync {
            var allSetups = [TrackedSetup]()
            var allFlats = [FlatOutcome]()

            let dir = outcomeDir
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []

            for file in files {
                if file.lastPathComponent.hasPrefix("setups_") {
                    if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
                    allSetups.append(contentsOf: loadTrackedSetups(url: file))
                }
                if file.lastPathComponent.hasPrefix("flats_") {
                    if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
                    allFlats.append(contentsOf: loadFlatOutcomes(url: file))
                }
            }

            let resolved = allSetups.filter { $0.outcome.resolved }
            let wins = resolved.filter { $0.outcome.tp1Hit && !$0.outcome.stopHit }
            let losses = resolved.filter { $0.outcome.stopHit && !$0.outcome.tp1Hit }

            let evaluatedFlats = allFlats.filter { $0.falseFlat != nil }
            let falseFlats = evaluatedFlats.filter { $0.falseFlat == true }

            // Average R:R achieved
            var avgRRAchieved: Double = 0
            if !resolved.isEmpty {
                let rrValues = resolved.compactMap { tracked -> Double? in
                    let s = tracked.setup
                    guard s.risk > 0, tracked.outcome.entryHit else { return nil }
                    let favorable = tracked.outcome.maxFavorable
                    return favorable / s.risk
                }
                if !rrValues.isEmpty { avgRRAchieved = rrValues.reduce(0, +) / Double(rrValues.count) }
            }

            return OutcomeStats(
                totalSetups: allSetups.count,
                resolvedSetups: resolved.count,
                wins: wins.count,
                losses: losses.count,
                winRate: resolved.isEmpty ? 0 : Double(wins.count) / Double(resolved.count) * 100,
                avgRRAchieved: avgRRAchieved,
                totalFlats: allFlats.count,
                evaluatedFlats: evaluatedFlats.count,
                falseFlats: falseFlats.count,
                falseFlatRate: evaluatedFlats.isEmpty ? 0 : Double(falseFlats.count) / Double(evaluatedFlats.count) * 100,
                recentSetups: Array(allSetups.prefix(10))
            )
        }
    }

    // MARK: - Restore from Server

    /// Fetch resolved outcomes from D1 and merge into local cache.
    /// Call on app launch when local cache is empty.
    static func restoreFromServer() async {
        // Only restore if local cache is empty
        let dir = outcomeDir
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        let hasSetups = files.contains { $0.lastPathComponent.hasPrefix("setups_") }
        guard !hasSetups else { return }

        guard let url = URL(string: "\(PushService.workerURL)/outcomes") else { return }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return }

        ioQueue.async {
            for item in json {
                guard let symbol = item["symbol"] as? String,
                      let direction = item["direction"] as? String,
                      let entry = item["entry"] as? Double,
                      let stopLoss = item["stopLoss"] as? Double,
                      let tp1 = item["tp1"] as? Double
                else { continue }

                let tp2 = item["tp2"] as? Double
                let setup = TradeSetup(direction: direction, entry: entry, stopLoss: stopLoss, tp1: tp1, tp2: tp2)
                let mlProb = item["mlProb"] as? Double
                let conviction = item["conviction"] as? String

                let fileURL = dir.appendingPathComponent("setups_\(symbol).json")
                var tracked = loadTrackedSetups(url: fileURL)
                var ts = TrackedSetup(setup: setup, symbol: symbol, analysisId: UUID(),
                                       mlProbability: mlProb, conviction: conviction)
                ts.synced = true

                // Restore outcome state
                if let outcome = item["outcome"] as? String {
                    if outcome == "tp1_win" { ts.outcome.entryHit = true; ts.outcome.tp1Hit = true }
                    else if outcome == "tp2_win" { ts.outcome.entryHit = true; ts.outcome.tp1Hit = true; ts.outcome.tp2Hit = true }
                    else if outcome == "loss" { ts.outcome.entryHit = true; ts.outcome.stopHit = true }
                }

                tracked.insert(ts, at: 0)
                save(tracked, to: fileURL)
            }
        }
    }

    // MARK: - Persistence

    private static func loadTrackedSetups(url: URL) -> [TrackedSetup] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([TrackedSetup].self, from: data)) ?? []
    }

    private static func loadFlatOutcomes(url: URL) -> [FlatOutcome] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([FlatOutcome].self, from: data)) ?? []
    }

    private static func save<T: Encodable>(_ value: T, to url: URL) {
        if let data = try? JSONEncoder().encode(value) {
            try? data.write(to: url, options: .atomic)
        }
    }
}

// MARK: - Models

struct TrackedSetup: Codable, Identifiable {
    let setup: TradeSetup
    let symbol: String
    let analysisId: UUID
    let timestamp: Date
    var outcome: TradeOutcome
    let killsAtGeneration: KillSnapshot?
    var synced: Bool
    let mlProbability: Double?
    let conviction: String?
    let modelVersion: Int

    var id: UUID { setup.id }

    private enum CodingKeys: String, CodingKey {
        case setup, symbol, analysisId, timestamp, outcome,
             killsAtGeneration, synced, mlProbability, conviction, modelVersion
    }

    init(setup: TradeSetup, symbol: String, analysisId: UUID, killSnapshot: KillSnapshot? = nil,
         mlProbability: Double? = nil, conviction: String? = nil, modelVersion: Int = 10) {
        self.setup = setup
        self.symbol = symbol
        self.analysisId = analysisId
        self.timestamp = Date()
        self.outcome = TradeOutcome()
        self.killsAtGeneration = killSnapshot
        self.synced = false
        self.mlProbability = mlProbability
        self.conviction = conviction
        self.modelVersion = modelVersion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        setup = try c.decode(TradeSetup.self, forKey: .setup)
        symbol = try c.decode(String.self, forKey: .symbol)
        analysisId = try c.decode(UUID.self, forKey: .analysisId)
        timestamp = try c.decode(Date.self, forKey: .timestamp)
        outcome = try c.decode(TradeOutcome.self, forKey: .outcome)
        killsAtGeneration = try c.decodeIfPresent(KillSnapshot.self, forKey: .killsAtGeneration)
        synced = (try? c.decode(Bool.self, forKey: .synced)) ?? false
        mlProbability = try c.decodeIfPresent(Double.self, forKey: .mlProbability)
        conviction = try c.decodeIfPresent(String.self, forKey: .conviction)
        modelVersion = try c.decodeIfPresent(Int.self, forKey: .modelVersion) ?? 10
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(setup, forKey: .setup)
        try c.encode(symbol, forKey: .symbol)
        try c.encode(analysisId, forKey: .analysisId)
        try c.encode(timestamp, forKey: .timestamp)
        try c.encode(outcome, forKey: .outcome)
        try c.encodeIfPresent(killsAtGeneration, forKey: .killsAtGeneration)
        try c.encode(synced, forKey: .synced)
        try c.encodeIfPresent(mlProbability, forKey: .mlProbability)
        try c.encodeIfPresent(conviction, forKey: .conviction)
        try c.encodeIfPresent(modelVersion, forKey: .modelVersion)
    }
}

struct OutcomeStats {
    let totalSetups: Int
    let resolvedSetups: Int
    let wins: Int
    let losses: Int
    let winRate: Double
    let avgRRAchieved: Double
    let totalFlats: Int
    let evaluatedFlats: Int
    let falseFlats: Int
    let falseFlatRate: Double
    let recentSetups: [TrackedSetup]
}
