import Foundation

/// Read-only display store over the SERVER's tracked-setup archive (2026-07-09 thin-client
/// cutover). The box registers every setup/FLAT at analysis time (`/full-analysis` →
/// `registerTrackedSetups`) and resolves them on its per-minute cron
/// (`resolveTrackedSetups` in marketscope-worker/src/outcome-tracking.ts) — outcomes advance
/// whether or not this app is ever opened. `refresh()` pulls `GET /tracked-setups` and caches
/// a snapshot to disk so the dashboard works offline.
///
/// The pre-cutover on-device lifecycle (registerSetup / trackSetupOutcomes / reEvaluate /
/// scanAllPendingSetups / syncResolvedOutcomes / registerFlatOutcome / trackFlatOutcomes /
/// restoreFromServer — which was already broken: it read camelCase keys from a snake_case
/// response) is DELETED. The legacy per-symbol archives (`setups_<SYM>.json` / `flats_<SYM>.json`)
/// are kept read-only and merged into stats as history: terminal rows only — legacy
/// pending/active rows would be frozen ghosts now that nothing on-device resolves them.
enum OutcomeTracker {
    private static let ioQueue = DispatchQueue(label: "com.ludikure.CryptoLens.outcomeIO")

    private static var outcomeDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("trade_outcomes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // Server snapshot files (distinct names from the legacy `setups_*`/`flats_*` per-symbol
    // archives, which stay read-only history).
    private static var serverSetupsURL: URL { outcomeDir.appendingPathComponent("server_setups.json") }
    private static var serverFlatsURL: URL { outcomeDir.appendingPathComponent("server_flats.json") }

    // MARK: - Server refresh

    /// Pull the device's tracked-setup archive from the worker and cache it. Called after each
    /// analysis refresh, at app launch, and when the Outcome dashboard opens. Best-effort — on
    /// any failure the previous snapshot keeps serving (offline dashboards).
    static func refresh() async {
        guard let resp = await WorkerTrackedSetupsService.fetch() else { return }
        let setups = resp.setups.compactMap { TrackedSetup(dto: $0) }
        let flats = resp.flats.map { dto in
            FlatOutcome(symbol: dto.symbol,
                        priceAtFlat: dto.priceAtSetup,
                        timestamp: Date(timeIntervalSince1970: dto.registeredAt / 1000),
                        reason: dto.flatReason ?? "FLAT",
                        priceAfter: dto.priceAfter,
                        falseFlat: dto.falseFlat)
        }
        ioQueue.async {
            save(setups, to: serverSetupsURL)
            save(flats, to: serverFlatsURL)
        }
    }

    // MARK: - Merged data sources (call on ioQueue)

    private static func serverSetupsLocked() -> [TrackedSetup] {
        loadTrackedSetups(url: serverSetupsURL)
    }

    private static func serverFlatsLocked() -> [FlatOutcome] {
        loadFlatOutcomes(url: serverFlatsURL)
    }

    /// Legacy on-device archive, terminal rows only (resolved or counted). Unresolved legacy
    /// rows are excluded everywhere — nothing on-device advances them anymore.
    private static func legacySetupsLocked(symbol: String? = nil) -> [TrackedSetup] {
        var all = [TrackedSetup]()
        let files = (try? FileManager.default.contentsOfDirectory(at: outcomeDir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasPrefix("setups_") {
            if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
            all.append(contentsOf: loadTrackedSetups(url: file).filter {
                $0.outcome.resolved || $0.outcome.isCounted
            })
        }
        return all
    }

    /// Legacy FLAT archive, evaluated rows only (unevaluated ones can never resolve now).
    private static func legacyFlatsLocked(symbol: String? = nil) -> [FlatOutcome] {
        var all = [FlatOutcome]()
        let files = (try? FileManager.default.contentsOfDirectory(at: outcomeDir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasPrefix("flats_") {
            if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
            all.append(contentsOf: loadFlatOutcomes(url: file).filter { $0.falseFlat != nil })
        }
        return all
    }

    /// Server snapshot + legacy terminal history, deduped by id (server wins), newest first.
    private static func mergedSetupsLocked(symbol: String? = nil) -> [TrackedSetup] {
        let server = serverSetupsLocked().filter { symbol == nil || $0.symbol == symbol }
        var seen = Set(server.map { $0.id })
        var merged = server
        for legacy in legacySetupsLocked(symbol: symbol) where !seen.contains(legacy.id) {
            seen.insert(legacy.id)
            merged.append(legacy)
        }
        return merged.sorted { $0.timestamp > $1.timestamp }
    }

    private static func mergedFlatsLocked(symbol: String? = nil) -> [FlatOutcome] {
        serverFlatsLocked().filter { symbol == nil || $0.symbol == symbol } + legacyFlatsLocked(symbol: symbol)
    }

    // MARK: - Active Setups Query

    /// Returns setups that are active (entered) or pending (conditional, waiting for trigger).
    /// Server rows only — legacy unresolved rows are frozen ghosts by definition.
    static func activeSetups(symbol: String) -> [TrackedSetup] {
        return ioQueue.sync {
            serverSetupsLocked().filter {
                $0.symbol == symbol &&
                (($0.outcome.state == .active && $0.outcome.entryHit && !$0.outcome.isCounted) ||
                 $0.outcome.state == .pending)
            }
        }
    }

    /// Non-blocking variant — call from UI contexts so disk loads don't hitch the main thread.
    static func activeSetupsAsync(symbol: String) async -> [TrackedSetup] {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let setups = serverSetupsLocked().filter {
                    $0.symbol == symbol &&
                    (($0.outcome.state == .active && $0.outcome.entryHit && !$0.outcome.isCounted) ||
                     $0.outcome.state == .pending)
                }
                continuation.resume(returning: setups)
            }
        }
    }

    /// Returns wins/losses for a (symbol, archetype) pair over the last N days.
    /// Win = tp1Hit or tp2Hit (resolved profitably). Loss = stopHit. Setups still
    /// active/pending or expired-no-fill are excluded — they have no verdict yet.
    /// Legacy stored setups (archetype == nil) are excluded.
    static func archetypeRecord(symbol: String, archetype: String, lookbackDays: Int = 30) -> (wins: Int, losses: Int, total: Int) {
        return ioQueue.sync {
            archetypeRecordLocked(symbol: symbol, archetype: archetype, lookbackDays: lookbackDays)
        }
    }

    /// Non-blocking variant.
    static func archetypeRecordAsync(symbol: String, archetype: String, lookbackDays: Int = 30) async -> (wins: Int, losses: Int, total: Int) {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                continuation.resume(returning: archetypeRecordLocked(symbol: symbol, archetype: archetype, lookbackDays: lookbackDays))
            }
        }
    }

    private static func archetypeRecordLocked(symbol: String, archetype: String, lookbackDays: Int) -> (wins: Int, losses: Int, total: Int) {
        let cutoff = Date().addingTimeInterval(TimeInterval(-lookbackDays * 86400))
        var wins = 0
        var losses = 0
        for s in mergedSetupsLocked(symbol: symbol) {
            guard s.archetype == archetype, s.timestamp >= cutoff else { continue }
            if s.outcome.tp1Hit || s.outcome.tp2Hit { wins += 1 }
            else if s.outcome.stopHit { losses += 1 }
            // active/pending/expired-no-fill: no verdict yet, skip
        }
        return (wins, losses, wins + losses)
    }

    /// Returns every tracked setup (server + legacy terminal history), newest first. `stats()`
    /// only includes the first 10 in `recentSetups` (UI cap); this is for export paths that
    /// need the full history.
    static func allSetups(symbol: String? = nil) -> [TrackedSetup] {
        return ioQueue.sync { mergedSetupsLocked(symbol: symbol) }
    }

    /// Non-blocking variant — preferred for dashboard views.
    static func allSetupsAsync(symbol: String? = nil) async -> [TrackedSetup] {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                continuation.resume(returning: mergedSetupsLocked(symbol: symbol))
            }
        }
    }

    // MARK: - Versioning constants
    // The prompt/model version REGISTRY OF RECORD is now server-side
    // (marketscope-worker/src/outcome-tracking.ts: TRACKED_PROMPT_VERSION /
    // TRACKED_MODEL_VERSION) — the server stamps every tracked setup at registration.
    // These constants remain for the prompt-TaskLocal plumbing and dashboard slicing.

    /// Baseline prompt+system version. Collapsed to match the treatment version 2026-05-30
    /// because this is a single-user system — an A/B with n=1 user cannot generate
    /// statistical power. If MarketScope grows to multiple users later, set
    /// treatmentPromptVersion to a new tag to restart A/B testing.
    static let baselinePromptVersion = "2026-05-30-stoch-direction"

    /// Treatment prompt+system version. Equal to baselinePromptVersion (A/B collapse).
    static let treatmentPromptVersion = "2026-05-30-stoch-direction"

    /// Back-compat alias for callers that didn't go through `assignedPromptVersion`.
    static let currentPromptVersion = baselinePromptVersion

    /// Deterministic A/B bucket. Same `(deviceId, day)` always maps to the same version.
    /// Post-collapse both branches return the same string; kept for a future multi-user
    /// restart. Honors `experiments_enabled` (Settings toggle removed 2026-07-09 — the
    /// UserDefault only exists on devices that set it historically).
    static func assignedPromptVersion(deviceId: String, date: Date = Date()) -> String {
        let experimentsEnabled = (UserDefaults.standard.object(forKey: "experiments_enabled") as? Bool) ?? true
        guard experimentsEnabled else { return baselinePromptVersion }

        let utc = TimeZone(identifier: "UTC")!
        let comps = Calendar(identifier: .iso8601).dateComponents(in: utc, from: date)
        let day = "\(comps.year ?? 0)-\(comps.month ?? 0)-\(comps.day ?? 0)"
        let combined = deviceId + "|" + day
        let sum = combined.utf8.reduce(0) { $0 &+ Int($1) }
        return (sum & 1 == 0) ? baselinePromptVersion : treatmentPromptVersion
    }

    /// Must match the `version` field of the worker's shipped ml-model-{crypto,stock}.json —
    /// both 14 as of the 2026-07-06 v14 retrain. The server's TRACKED_MODEL_VERSION
    /// (outcome-tracking.ts) is the registry of record now; keep this, the worker outcome
    /// query, and the JSONs in sync on retrains.
    static func currentModelVersion(for symbol: String) -> Int {
        symbol.hasSuffix("USDT") ? 14 : 14
    }

    // MARK: - Stats

    /// Compute outcome statistics for dashboard (server snapshot + legacy terminal history).
    static func stats(symbol: String? = nil) -> OutcomeStats {
        return ioQueue.sync {
            let allSetups = mergedSetupsLocked(symbol: symbol)
            let allFlats = mergedFlatsLocked(symbol: symbol)

            // Only count setups that reached ACTIVE state
            let counted = allSetups.filter { $0.outcome.state == .active }
            let resolved = counted.filter { $0.outcome.isCounted }
            let wins = resolved.filter { $0.outcome.tp1Hit }
            let losses = resolved.filter { $0.outcome.stopHit && !$0.outcome.tp1Hit && !$0.outcome.partialTaken }
            let partialBE = resolved.filter { $0.outcome.stopHit && !$0.outcome.tp1Hit && $0.outcome.partialTaken }

            let pending = allSetups.filter { $0.outcome.state == .pending }
            let invalidated = allSetups.filter { $0.outcome.state == .invalidated }
            let expired = allSetups.filter { $0.outcome.state == .expired }

            let evaluatedFlats = allFlats.filter { $0.falseFlat != nil }
            let falseFlats = evaluatedFlats.filter { $0.falseFlat == true }

            // Average R:R achieved (on counted setups only)
            var avgRRAchieved: Double = 0
            if !resolved.isEmpty {
                let rrValues = resolved.compactMap { tracked -> Double? in
                    let s = tracked.setup
                    guard s.risk > 0, tracked.outcome.entryHit else { return nil }
                    return tracked.outcome.maxFavorable / s.risk
                }
                if !rrValues.isEmpty { avgRRAchieved = rrValues.reduce(0, +) / Double(rrValues.count) }
            }

            // Group invalidation reasons
            var invalidReasons: [String: Int] = [:]
            for inv in invalidated {
                let reason = inv.outcome.reEvalResult?.reason ?? "unknown"
                let category: String
                if reason.contains("Direction") { category = "direction" }
                else if reason.contains("ML_WIN") { category = "ml_drift" }
                else if reason.contains("Kill") || reason.contains("kill") { category = "kills" }
                else if reason.contains("No cached") { category = "no_data" }
                else if reason.contains("no setup") { category = "flat" }
                else { category = "other" }
                invalidReasons[category, default: 0] += 1
            }

            return OutcomeStats(
                generatedSetups: allSetups.count,
                countedSetups: counted.count,
                resolvedSetups: resolved.count,
                wins: wins.count,
                losses: losses.count,
                partialBE: partialBE.count,
                pendingSetups: pending.count,
                invalidatedSetups: invalidated.count,
                expiredSetups: expired.count,
                invalidReasons: invalidReasons,
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

    // MARK: - Per-version A/B aggregation

    /// Outcome stats sliced by `promptVersion`. Same definitions as `OutcomeStats` but keyed
    /// by the version string the setup was registered under.
    static func versionStats(lookbackDays: Int = 30) -> [String: VersionStats] {
        return ioQueue.sync {
            let cutoff = Date().addingTimeInterval(-Double(lookbackDays) * 86400)
            var setupsByVersion: [String: [TrackedSetup]] = [:]
            for ts in mergedSetupsLocked() where ts.timestamp >= cutoff {
                setupsByVersion[ts.promptVersion, default: []].append(ts)
            }

            return setupsByVersion.mapValues { setups in
                let counted = setups.filter { $0.outcome.state == .active }
                let resolved = counted.filter { $0.outcome.isCounted }
                let wins = resolved.filter { $0.outcome.tp1Hit }
                let losses = resolved.filter { $0.outcome.stopHit && !$0.outcome.tp1Hit && !$0.outcome.partialTaken }
                let partialBE = resolved.filter { $0.outcome.stopHit && !$0.outcome.tp1Hit && $0.outcome.partialTaken }
                let invalidated = setups.filter { $0.outcome.state == .invalidated }
                let expired = setups.filter { $0.outcome.state == .expired }

                var avgRR: Double = 0
                if !resolved.isEmpty {
                    let rrValues = resolved.compactMap { tracked -> Double? in
                        let s = tracked.setup
                        guard s.risk > 0, tracked.outcome.entryHit else { return nil }
                        return tracked.outcome.maxFavorable / s.risk
                    }
                    if !rrValues.isEmpty { avgRR = rrValues.reduce(0, +) / Double(rrValues.count) }
                }

                return VersionStats(
                    totalSetups: setups.count,
                    countedSetups: counted.count,
                    resolvedSetups: resolved.count,
                    wins: wins.count,
                    losses: losses.count,
                    partialBE: partialBE.count,
                    invalidatedSetups: invalidated.count,
                    expiredSetups: expired.count,
                    winRate: resolved.isEmpty ? 0 : Double(wins.count) / Double(resolved.count) * 100,
                    avgRRAchieved: avgRR
                )
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

    // MARK: - F-4 Overtrading / cooling-off guard

    /// Number of setups surfaced to the user today (local calendar day), across all symbols.
    /// A proxy for "trades considered" — each registered setup is one the app put in front of
    /// the user as actionable.
    static func setupsConsideredToday() -> Int {
        let cal = Calendar.current
        return allSetups().filter { cal.isDateInToday($0.timestamp) }.count
    }

    /// Gentle cooling-off nudge for a user with a full-time job who shouldn't be overtrading.
    /// Returns nil while within the user's stated daily cadence; otherwise a plain-language
    /// reminder. Cadence is the `daily_trade_cadence` UserDefault (default 2). Counters the
    /// dopamine loop without hard-blocking anything.
    static func overtradingNudge() -> String? {
        let cadence = max(1, UserDefaults.standard.object(forKey: "daily_trade_cadence") as? Int ?? 2)
        let n = setupsConsideredToday()
        guard n > cadence else { return nil }
        return "You've had \(n) setups surface today — your plan is \(cadence) or fewer. Extra setups are usually the marginal ones, and marginal trades are typically –EV after fees. Stepping back is often the highest-EV move you can make today."
    }

    // MARK: - F-5 Post-trade debrief

    private static func humanizeArchetype(_ a: String) -> String {
        switch a {
        case "MOMENTUM_CONTINUATION": return "momentum-continuation"
        case "COUNTER_TREND_PULLBACK": return "pullback"
        case "COUNTER_TREND_REVERSAL": return "counter-trend reversal"
        case "BREAKOUT_RETEST": return "breakout-retest"
        case "RANGE_EDGE_FADE": return "range-edge fade"
        default: return a.lowercased().replacingOccurrences(of: "_", with: " ")
        }
    }

    private static func fmtR(_ v: Double) -> String { String(format: "%.1fR", abs(v)) }

    /// Plain-language autopsy for a RESOLVED tracked trade — turns the outcome tracker into a
    /// teacher, not just a scoreboard. Honest, derived entirely from what was recorded at entry
    /// (archetype, ML quality, whether the entry was a breakout/chase) + the realized excursion
    /// + the archetype's own track record. Returns nil for unresolved trades.
    static func debrief(for t: TrackedSetup) -> String? {
        let o = t.outcome
        guard o.state == .active, (o.tp1Hit || o.tp2Hit || o.stopHit) else { return nil }
        let isLong = t.setup.direction == "LONG"
        let win = o.tp1Hit
        let loss = o.stopHit && !o.tp1Hit && !o.partialTaken
        let result = win ? (o.tp2Hit ? "a full WIN (ran to TP2)" : "a WIN (TP1 hit)")
                         : (loss ? "a LOSS" : "a break-even (stopped after a partial)")

        var parts: [String] = ["\(t.symbol) \(t.setup.direction) — \(result)."]

        // Excursion story in R units.
        let risk = t.setup.risk
        if risk > 0 {
            let favR = o.maxFavorable / risk
            if loss {
                parts.append(favR >= 0.5
                    ? "It ran +\(fmtR(favR)) in your favor before reversing into the stop."
                    : "It went against you almost immediately (peak only +\(fmtR(favR))).")
            } else if win {
                parts.append("Peak +\(fmtR(favR)) favorable.")
            }
        }

        // Entry-quality context from what was recorded.
        var entryNotes: [String] = []
        if t.priceAtSetup > 0 {
            let chase = (isLong && t.setup.entry > t.priceAtSetup) || (!isLong && t.setup.entry < t.priceAtSetup)
            if chase { entryNotes.append("you entered in the breakout direction (a chase entry)") }
        }
        if let ml = t.mlProbability { entryNotes.append("ML move-quality was \(Int((ml * 100).rounded()))%") }
        if let arch = t.archetype { entryNotes.append("pattern was \(humanizeArchetype(arch))") }
        if !entryNotes.isEmpty { parts.append("At entry: " + entryNotes.joined(separator: ", ") + ".") }

        // Lesson from this archetype's track record for this symbol.
        if let arch = t.archetype {
            let rec = archetypeRecord(symbol: t.symbol, archetype: arch, lookbackDays: 180)
            if rec.total >= 3 {
                let rate = Double(rec.wins) / Double(rec.total)
                if loss && rate < 0.45 {
                    parts.append("Lesson: your \(humanizeArchetype(arch)) trades are \(rec.wins)–\(rec.losses) — this pattern hasn't paid off; demand stronger confirmation or skip it.")
                } else if win && rate >= 0.55 {
                    parts.append("This pattern is working for you (\(rec.wins)–\(rec.losses)) — repeatable.")
                }
            }
        }
        return parts.joined(separator: " ")
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
    let setupType: SetupType
    /// Live price at the moment the setup was registered. Used to distinguish pullback vs
    /// breakout (chase) entries in the debrief. 0 if missing on legacy stored setups.
    let priceAtSetup: Double
    /// Prompt + system-behavior version snapshot at registration time (stamped server-side
    /// since the 2026-07-09 cutover). Lets us slice the outcome archive by system-iteration.
    let promptVersion: String
    /// Setup archetype at registration time (e.g. COUNTER_TREND_PULLBACK,
    /// MOMENTUM_CONTINUATION). Optional so legacy stored data decodes as nil.
    /// Used by `archetypeRecord` to slice win/loss by setup pattern.
    let archetype: String?

    var id: UUID { setup.id }

    private enum CodingKeys: String, CodingKey {
        case setup, symbol, analysisId, timestamp, outcome,
             killsAtGeneration, synced, mlProbability, conviction, modelVersion, setupType,
             priceAtSetup, promptVersion, archetype
    }

    init(setup: TradeSetup, symbol: String, analysisId: UUID, killSnapshot: KillSnapshot? = nil,
         mlProbability: Double? = nil, conviction: String? = nil,
         modelVersion: Int? = nil,
         setupType: SetupType = .market, priceAtSetup: Double = 0,
         promptVersion: String = OutcomeTracker.currentPromptVersion,
         archetype: String? = nil) {
        let resolvedModelVersion = modelVersion ?? OutcomeTracker.currentModelVersion(for: symbol)
        self.setup = setup
        self.symbol = symbol
        self.analysisId = analysisId
        self.timestamp = Date()
        self.outcome = TradeOutcome()
        self.killsAtGeneration = killSnapshot
        self.synced = false
        self.mlProbability = mlProbability
        self.conviction = conviction
        self.modelVersion = resolvedModelVersion
        self.setupType = setupType
        self.priceAtSetup = priceAtSetup
        self.promptVersion = promptVersion
        self.archetype = archetype
    }

    /// Map a server tracked_setups row (GET /tracked-setups) into the local display model.
    /// Returns nil for rows missing the core setup fields (shouldn't happen for kind='setup').
    init?(dto: WorkerTrackedSetupsService.SetupDTO) {
        guard let direction = dto.direction, let entry = dto.entry,
              let stopLoss = dto.stopLoss, let tp1 = dto.tp1 else { return nil }
        // The server mints real UUIDs (crypto.randomUUID); keep them so Identifiable is
        // stable across refreshes. Unparseable ids fall back to a fresh UUID.
        let id = UUID(uuidString: dto.id) ?? UUID()
        self.setup = TradeSetup(id: id, direction: direction, entry: entry, stopLoss: stopLoss,
                                tp1: tp1, tp2: dto.tp2, reasoning: dto.reasoning ?? "")
        self.symbol = dto.symbol
        self.analysisId = UUID()   // not tracked server-side; unused by consumers
        self.timestamp = Date(timeIntervalSince1970: dto.registeredAt / 1000)
        self.killsAtGeneration = nil
        self.synced = true         // server rows ARE the synced record
        self.mlProbability = dto.mlAtRegistration
        self.conviction = dto.conviction
        self.modelVersion = dto.modelVersion
        self.setupType = SetupType(rawValue: dto.setupType ?? "market") ?? .market
        self.priceAtSetup = dto.priceAtSetup
        self.promptVersion = dto.promptVersion
        self.archetype = dto.archetype

        var o = TradeOutcome()
        o.state = SetupState(rawValue: dto.state) ?? .active
        o.entryHit = dto.entryHit
        if let hitAt = dto.entryHitAt { o.entryHitTime = Date(timeIntervalSince1970: hitAt / 1000) }
        o.stopHit = dto.stopHit
        o.tp1Hit = dto.tp1Hit
        o.tp2Hit = dto.tp2Hit
        o.breakevenActivated = dto.breakevenActivated
        o.partialTaken = dto.partialTaken
        o.maxFavorable = dto.maxFavorable
        o.maxAdverse = dto.maxAdverse
        if let resolvedAt = dto.resolvedAt { o.outcomeTime = Date(timeIntervalSince1970: resolvedAt / 1000) }
        if let expiresAt = dto.pendingExpiresAt { o.pendingExpiresAt = Date(timeIntervalSince1970: expiresAt / 1000) }
        if let reason = dto.invalidReason {
            o.reEvalResult = ReEvalResult(direction: "", mlWin: nil, killsActive: false,
                                          validated: false, reason: reason)
        }
        self.outcome = o
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
        setupType = (try? c.decode(SetupType.self, forKey: .setupType)) ?? .market
        priceAtSetup = (try? c.decode(Double.self, forKey: .priceAtSetup)) ?? 0
        // Legacy setups (pre-2026-05-09) lack promptVersion. Stamp them as "legacy"
        // so they segregate from current-iteration trades in the archive.
        promptVersion = (try? c.decode(String.self, forKey: .promptVersion)) ?? "legacy"
        archetype = try c.decodeIfPresent(String.self, forKey: .archetype)
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
        try c.encode(setupType, forKey: .setupType)
        try c.encode(priceAtSetup, forKey: .priceAtSetup)
        try c.encode(promptVersion, forKey: .promptVersion)
        try c.encodeIfPresent(archetype, forKey: .archetype)
    }
}

/// One row of the A/B comparison table. Computed by `OutcomeTracker.versionStats`
/// from the tracked-setup archive — no separate storage, just a `groupBy promptVersion`.
struct VersionStats {
    let totalSetups: Int          // All setups registered under this version
    let countedSetups: Int        // Reached ACTIVE state (entry triggered)
    let resolvedSetups: Int       // Reached terminal state (tp1Hit/stopHit/expired)
    let wins: Int
    let losses: Int
    let partialBE: Int
    let invalidatedSetups: Int
    let expiredSetups: Int
    let winRate: Double           // wins / resolved, 0–100
    let avgRRAchieved: Double     // Average maxFavorable / risk on resolved
}

struct OutcomeStats {
    let generatedSetups: Int      // Total emitted by LLM
    let countedSetups: Int        // Reached ACTIVE state
    let resolvedSetups: Int
    let wins: Int
    let losses: Int
    let partialBE: Int
    let pendingSetups: Int
    let invalidatedSetups: Int
    let expiredSetups: Int
    let invalidReasons: [String: Int]
    let winRate: Double
    let avgRRAchieved: Double
    let totalFlats: Int
    let evaluatedFlats: Int
    let falseFlats: Int
    let falseFlatRate: Double
    let recentSetups: [TrackedSetup]
}
