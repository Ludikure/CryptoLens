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

    // MARK: - Active Setups Query

    /// Returns setups that are active (entered) or pending (conditional, waiting for trigger).
    static func activeSetups(symbol: String) -> [TrackedSetup] {
        return ioQueue.sync {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            return loadTrackedSetups(url: url).filter {
                ($0.outcome.state == .active && $0.outcome.entryHit && !$0.outcome.isCounted) ||
                $0.outcome.state == .pending
            }
        }
    }

    /// Non-blocking variant — call from UI contexts so heavy disk loads don't hitch
    /// the main thread.
    static func activeSetupsAsync(symbol: String) async -> [TrackedSetup] {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
                let setups = loadTrackedSetups(url: url).filter {
                    ($0.outcome.state == .active && $0.outcome.entryHit && !$0.outcome.isCounted) ||
                    $0.outcome.state == .pending
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
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            let cutoff = Date().addingTimeInterval(TimeInterval(-lookbackDays * 86400))
            var wins = 0
            var losses = 0
            for s in loadTrackedSetups(url: url) {
                guard s.archetype == archetype, s.timestamp >= cutoff else { continue }
                if s.outcome.tp1Hit || s.outcome.tp2Hit { wins += 1 }
                else if s.outcome.stopHit { losses += 1 }
                // active/pending/expired-no-fill: no verdict yet, skip
            }
            return (wins, losses, wins + losses)
        }
    }

    /// Non-blocking variant.
    static func archetypeRecordAsync(symbol: String, archetype: String, lookbackDays: Int = 30) async -> (wins: Int, losses: Int, total: Int) {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
                let cutoff = Date().addingTimeInterval(TimeInterval(-lookbackDays * 86400))
                var wins = 0
                var losses = 0
                for s in loadTrackedSetups(url: url) {
                    guard s.archetype == archetype, s.timestamp >= cutoff else { continue }
                    if s.outcome.tp1Hit || s.outcome.tp2Hit { wins += 1 }
                    else if s.outcome.stopHit { losses += 1 }
                }
                continuation.resume(returning: (wins, losses, wins + losses))
            }
        }
    }

    /// Returns every tracked setup across every symbol, newest first. `stats()` only
    /// includes the first 10 in `recentSetups` (UI cap); this is for export paths
    /// that need the full history.
    static func allSetups(symbol: String? = nil) -> [TrackedSetup] {
        return ioQueue.sync {
            var all = [TrackedSetup]()
            let dir = outcomeDir
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.lastPathComponent.hasPrefix("setups_") {
                if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
                all.append(contentsOf: loadTrackedSetups(url: file))
            }
            return all.sorted { $0.timestamp > $1.timestamp }
        }
    }

    /// Non-blocking variant — preferred for dashboard views where the directory scan
    /// can grow as outcome history accumulates.
    static func allSetupsAsync(symbol: String? = nil) async -> [TrackedSetup] {
        await withCheckedContinuation { continuation in
            ioQueue.async {
                var all = [TrackedSetup]()
                let dir = outcomeDir
                let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
                for file in files where file.lastPathComponent.hasPrefix("setups_") {
                    if let sym = symbol, !file.lastPathComponent.contains(sym) { continue }
                    all.append(contentsOf: loadTrackedSetups(url: file))
                }
                continuation.resume(returning: all.sorted { $0.timestamp > $1.timestamp })
            }
        }
    }

    // MARK: - Trade Setup Outcomes

    /// Called during each refresh cycle with current price and recent candles.
    /// `cachedResult` is the latest AnalysisResult for this symbol (from resultsBySymbol).
    static func trackSetupOutcomes(symbol: String, currentPrice: Double,
                                    recentCandles: [Candle] = [],
                                    cachedResult: AnalysisResult? = nil) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            var tracked = loadTrackedSetups(url: url)
            var changed = false

            // Build price check points with open for same-candle heuristic
            struct PricePoint { let open: Double; let high: Double; let low: Double; let time: Date }
            var checkPoints = recentCandles.map { PricePoint(open: $0.open, high: $0.high, low: $0.low, time: $0.time) }
            checkPoints.append(PricePoint(open: currentPrice, high: currentPrice, low: currentPrice, time: Date()))

            for i in tracked.indices {
                let state = tracked[i].outcome.state

                // Skip resolved, invalidated, expired. `resolved` covers
                // stopHit/tp2Hit — tp1Hit alone is NOT resolution because the runner
                // continues until TP2 hits or the (now-breakeven) stop is hit. Was
                // `isCounted` which included tp1Hit, short-circuiting the inner loop
                // and freezing tracking at the first TP1 cross — 23 of 24 winners
                // in production never registered TP2 because of it.
                if state == .invalidated || state == .expired { continue }
                if state == .active && tracked[i].outcome.resolved { continue }

                // --- PENDING state: check timeout, proactive re-validation, and entry trigger ---
                if state == .pending {
                    let setupId = tracked[i].setup.id

                    // Timeout check (12h)
                    if let expires = tracked[i].outcome.pendingExpiresAt, Date() > expires {
                        tracked[i].outcome.state = .expired
                        tracked[i].outcome.reEvalResult = ReEvalResult(
                            direction: "", mlWin: nil, killsActive: false,
                            validated: false, reason: "Pending window expired (12h)")
                        changed = true
                        Task { await WorkerPendingSetupService.cancel(setupId: setupId) }
                        continue
                    }

                    // Proactive re-validation for aging pending setups. Without this,
                    // a setup created at 9am could sit in pending until entry is touched
                    // at 3pm — by which time the original conditions (ML, kills, regime)
                    // may have materially changed. Run reEvaluate on every refresh once
                    // the setup is >= 1h old; if invalidated, mark immediately rather than
                    // waiting for the entry touch to surface the staleness.
                    let setupAge = Date().timeIntervalSince(tracked[i].timestamp)
                    if setupAge >= 3600 {
                        let proactiveEval = reEvaluate(original: tracked[i], cachedResult: cachedResult)
                        if !proactiveEval.validated {
                            tracked[i].outcome.state = .invalidated
                            tracked[i].outcome.reEvalResult = proactiveEval
                            changed = true
                            print("[OutcomeTracker] Proactive invalidation \(symbol): \(proactiveEval.reason)")
                            Task { await WorkerPendingSetupService.cancel(setupId: setupId) }
                            continue
                        }
                    }

                    // Check if entry price was touched
                    let setup = tracked[i].setup
                    let isLong = setup.direction == "LONG"
                    let entryTouched = checkPoints.filter { $0.time >= tracked[i].timestamp }.contains { point in
                        isLong ? point.low <= setup.entry : point.high >= setup.entry
                    }

                    if entryTouched {
                        // Run lightweight re-evaluation at the entry-touch moment too.
                        // (Proactive eval above may have validated 30 min ago; if state changed
                        // since then we want to catch it before activating the trade.)
                        let evalResult = reEvaluate(original: tracked[i], cachedResult: cachedResult)
                        tracked[i].outcome.reEvalResult = evalResult

                        if evalResult.validated {
                            tracked[i].outcome.state = .active
                            tracked[i].outcome.entryHit = true
                            tracked[i].outcome.entryHitTime = Date()
                        } else {
                            tracked[i].outcome.state = .invalidated
                        }
                        changed = true
                        // Either way, the setup is no longer pending — cancel worker tracking.
                        Task { await WorkerPendingSetupService.cancel(setupId: setupId) }
                    }
                    continue
                }

                // --- ACTIVE state: normal outcome tracking ---
                let setup = tracked[i].setup
                let isLong = setup.direction == "LONG"
                let setupTime = tracked[i].timestamp
                let risk = setup.risk

                // Determine active stop level based on management state
                var activeStop: Double
                if tracked[i].outcome.breakevenActivated {
                    activeStop = setup.entry
                } else if let entryTime = tracked[i].outcome.entryHitTime,
                          Date().timeIntervalSince(entryTime) > 6 * 3600,
                          risk > 0,
                          tracked[i].outcome.maxFavorable / risk < 0.5 {
                    let tightenedRisk = risk * 0.7
                    activeStop = isLong ? setup.entry - tightenedRisk : setup.entry + tightenedRisk
                } else {
                    activeStop = setup.stopLoss
                }

                let relevantPoints = checkPoints.filter { $0.time >= setupTime }

                let priceAtSetup = tracked[i].priceAtSetup

                for point in relevantPoints {
                    // Check entry hit (for market setups that weren't auto-entered).
                    // Direction-aware: price must move FROM priceAtSetup TOWARD entry to fire.
                    // - LONG below setup price (pullback long)  → low <= entry
                    // - LONG above setup price (breakout long)  → high >= entry
                    // - SHORT above setup price (pullback short)→ high >= entry
                    // - SHORT below setup price (breakdown shrt)→ low <= entry
                    // Without priceAtSetup (legacy setups), fall back to the old direction-only check.
                    if !tracked[i].outcome.entryHit {
                        let entryHit: Bool
                        if priceAtSetup > 0 {
                            if abs(setup.entry - priceAtSetup) / priceAtSetup < 0.001 {
                                entryHit = true   // market entry (within 0.1%)
                            } else if setup.entry < priceAtSetup {
                                entryHit = point.low <= setup.entry  // price must fall to entry
                            } else {
                                entryHit = point.high >= setup.entry // price must rise to entry
                            }
                        } else {
                            entryHit = isLong ? point.low <= setup.entry : point.high >= setup.entry
                        }
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

                    // Once resolved, only track excursions. tp1Hit alone is NOT resolution —
                    // the runner continues until TP2 hits or the (now-breakeven) stop is hit.
                    // Pre-2026-05-09 this used `isCounted` which included tp1Hit, causing every
                    // post-TP1 bar to skip tracking and stamp the trade tp1_win permanently —
                    // 23/24 winners in the production data never registered TP2 because of it.
                    if tracked[i].outcome.stopHit || tracked[i].outcome.tp2Hit { continue }

                    // Check breakeven activation: price reached +1.0 R:R from entry
                    if !tracked[i].outcome.breakevenActivated && risk > 0 {
                        let favorableRR = favorable / risk
                        if favorableRR >= 1.0 {
                            tracked[i].outcome.breakevenActivated = true
                            tracked[i].outcome.partialTaken = true
                            activeStop = setup.entry
                            changed = true
                        }
                    }

                    // Check stop and TP1 with open-proximity heuristic
                    let stopHit = isLong ? point.low <= activeStop : point.high >= activeStop
                    let tp1Hit = isLong ? point.high >= setup.tp1 : point.low <= setup.tp1

                    if stopHit && tp1Hit && !tracked[i].outcome.tp1Hit {
                        let distToStop = abs(point.open - activeStop)
                        let distToTP1 = abs(point.open - setup.tp1)
                        if distToStop <= distToTP1 {
                            tracked[i].outcome.stopHit = true
                            tracked[i].outcome.outcomeTime = point.time
                            changed = true; break
                        } else {
                            tracked[i].outcome.tp1Hit = true
                            changed = true
                        }
                    } else if stopHit {
                        tracked[i].outcome.stopHit = true
                        tracked[i].outcome.outcomeTime = point.time
                        changed = true; break
                    } else if tp1Hit && !tracked[i].outcome.tp1Hit {
                        tracked[i].outcome.tp1Hit = true
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

            // Expire old pending setups and untriggered active setups (7 days)
            let cutoff = Date().addingTimeInterval(-7 * 86400)
            let before = tracked.count
            tracked.removeAll { !$0.outcome.entryHit && $0.outcome.state == .active && $0.timestamp < cutoff }
            if tracked.count != before { changed = true }

            if changed { save(tracked, to: url) }
        }
    }

    // MARK: - Lightweight Re-Evaluation

    /// Compare the original setup against cached analysis data.
    /// No LLM call — uses ML score, kill conditions, and direction from the latest refresh.
    private static func reEvaluate(original: TrackedSetup,
                                    cachedResult: AnalysisResult?) -> ReEvalResult {
        // If no cached result (symbol not currently selected), conservative invalidation
        guard let result = cachedResult else {
            return ReEvalResult(direction: "", mlWin: nil, killsActive: false,
                                validated: false,
                                reason: "No cached data — symbol not active")
        }

        let newDirection = result.tradeSetups.first?.direction ?? "FLAT"
        let newMLWin = result.daily.mlWinProbability
        let originalML = original.mlProbability ?? 0

        // Check 1: Direction agreement
        if newDirection != original.setup.direction && newDirection != "FLAT" {
            return ReEvalResult(direction: newDirection, mlWin: newMLWin,
                                killsActive: false, validated: false,
                                reason: "Direction changed: \(original.setup.direction) → \(newDirection)")
        }

        // Check 2: Latest analysis produced no setup (FLAT)
        if result.tradeSetups.isEmpty && !result.claudeAnalysis.isEmpty {
            let hasNoSetup = result.claudeAnalysis.contains("NO SETUP") ||
                             result.claudeAnalysis.contains("BLOCKED")
            if hasNoSetup {
                return ReEvalResult(direction: "FLAT", mlWin: newMLWin,
                                    killsActive: false, validated: false,
                                    reason: "Latest analysis: no setup proposed")
            }
        }

        // Check 3: Kill conditions active
        let killDurKey = "killDur_\(original.symbol)"
        let durState = UserDefaults.standard.dictionary(forKey: killDurKey) as? [String: Int] ?? [:]
        let killsActive = (durState["divergence"] ?? 0) > 0 ||
                          (durState["volume"] ?? 0) > 0 ||
                          (durState["funding"] ?? 0) > 0
        if killsActive {
            var reasons = [String]()
            if (durState["divergence"] ?? 0) > 0 { reasons.append("divergence") }
            if (durState["volume"] ?? 0) > 0 { reasons.append("counter-volume") }
            if (durState["funding"] ?? 0) > 0 { reasons.append("funding flip") }
            return ReEvalResult(direction: newDirection, mlWin: newMLWin,
                                killsActive: true, validated: false,
                                reason: "Kill conditions active: \(reasons.joined(separator: ", "))")
        }

        // Check 4: ML score drift (24h gate)
        if let ml = newMLWin {
            if ml < 0.50 {
                return ReEvalResult(direction: newDirection, mlWin: ml,
                                    killsActive: false, validated: false,
                                    reason: "ML_WIN below 50% (\(Int(ml * 100))%)")
            }
            if originalML > 0 {
                let drift = originalML - ml
                if drift > 0.15 {
                    return ReEvalResult(direction: newDirection, mlWin: ml,
                                        killsActive: false, validated: false,
                                        reason: "ML_WIN dropped \(Int(drift * 100))pp (\(Int(originalML * 100))% → \(Int(ml * 100))%)")
                }
            }
        }

        // Check 5: ML Persistence drop (72h exit-strategy gate). If persistence collapses
        // below 40% (deep LOW bucket) on a runner-dependent setup, the exit thesis is
        // broken even if the 24h ML is still favorable — the runner won't reach TP2 and
        // tight TP1-only setups are usually presented as conditional anyway.
        if let mlH72 = result.daily.mlPersistenceProbability {
            if mlH72 < 0.40 {
                return ReEvalResult(direction: newDirection, mlWin: newMLWin,
                                    killsActive: false, validated: false,
                                    reason: "ML Persistence collapsed below 40% (\(Int(mlH72 * 100))%) — runner thesis broken")
            }
        }

        // All checks passed
        return ReEvalResult(direction: newDirection, mlWin: newMLWin,
                            killsActive: false, validated: true,
                            reason: "Re-eval confirmed: \(original.setup.direction), ML \(newMLWin.map { "\(Int($0 * 100))%" } ?? "n/a")")
    }

    // MARK: - Registration

    /// Baseline prompt+system version. Collapsed to match the treatment version
    /// 2026-05-30 because this is a single-user system — an A/B with n=1 user
    /// cannot generate statistical power, and the worker's notification gate
    /// change (bias OR Stoch union) was creating an asymmetric UX where baseline
    /// users got Stoch-routed notifications that the baseline prompt couldn't
    /// interpret (biases_MIXED auto-FLAT would kill the LLM analysis even though
    /// the worker had reasons to fire the notification). Both constants now equal
    /// the same string so the entire system runs the consolidated current-best
    /// prompt. If MarketScope grows to multiple users later, set treatmentPromptVersion
    /// to a new tag to restart A/B testing relative to this consolidated baseline.
    static let baselinePromptVersion = "2026-05-30-stoch-direction"

    /// Treatment prompt+system version. Bundles the six changes shipped 2026-05-30:
    ///   - Band-default inversion (carried over from 2026-05-29-experiment)
    ///   - STOCH_CROSS direction signal (co-equal direction primitive — broadened
    ///     2026-05-30 after the direction_primitive_sweep backtest)
    ///   - LONG confirmation gate (relStrengthVsSpy >= 1 AND dRsiDelta >= 1)
    ///   - BB extreme inversion (don't fade band touches at 24h)
    ///   - aligned_bearish SHORT restrictions (stocks only — crypto SHORTs are
    ///     +0.95R EV; restriction would block the highest-EV cell on crypto)
    ///   - TRANSITIONING regime conviction boost (allow HIGH when other gates pass)
    ///   - MACRO_CONTEXT block (DXY/VIX/IWM-SPY interpretive labels)
    /// Equal to baselinePromptVersion now (see comment above on the A/B collapse).
    static let treatmentPromptVersion = "2026-05-30-stoch-direction"

    /// Back-compat alias for callers that didn't go through `assignedPromptVersion`.
    /// New code should call the bucketing function instead.
    static let currentPromptVersion = baselinePromptVersion

    /// Deterministic A/B bucket. Same `(deviceId, day)` always maps to the same
    /// version so a single user's day isn't split mid-session. Different days
    /// re-randomize, so over weeks a device contributes to both populations.
    /// Honors `experiments_enabled` UserDefault (default true) — when false, always
    /// returns baseline. Hash is a UTF-8 byte sum (stable across processes, unlike
    /// Swift's seeded `Hasher`).
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
    /// both 14 as of the 2026-07-06 v14 retrain (full-coverage derivatives regen; crypto
    /// LightGBM d4 t150, stock XGBoost d5 t100, 110 features).
    /// Pre-2026-07-01 this returned 10 for crypto (a leak-era leftover) while the worker's
    /// outcome-feedback query filtered on 11/13 — so the LLM's trade-record lookup matched
    /// nothing. The worker now queries IN(10,11,12,14) crypto / IN(12,13,14) stock; keep all
    /// three registries (this, the worker query, the JSONs) in sync on retrains.
    static func currentModelVersion(for symbol: String) -> Int {
        symbol.hasSuffix("USDT") ? 14 : 14
    }

    /// Register a new setup for tracking. Classifies as market or conditional.
    /// `modelVersion` defaults to the asset-class-appropriate value via the resolver
    /// above, so callers don't need to keep crypto/stock mapping in sync separately.
    static func registerSetup(_ setup: TradeSetup, symbol: String, analysisId: UUID,
                              currentPrice: Double = 0,
                              mlProbability: Double? = nil, conviction: String? = nil,
                              modelVersion: Int? = nil,
                              promptVersion: String = currentPromptVersion,
                              archetype: String? = nil,
                              atrAtRegistration: Double? = nil) {
        let resolvedModelVersion = modelVersion ?? currentModelVersion(for: symbol)
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            var tracked = loadTrackedSetups(url: url)

            // Don't duplicate
            guard !tracked.contains(where: { $0.setup.id == setup.id }) else { return }

            let setupType = currentPrice > 0
                ? SetupType.classify(entry: setup.entry, currentPrice: currentPrice, reasoning: setup.reasoning)
                : .market  // Fallback if no price provided

            // Log breakout/breakdown entries (entry on the "wrong" side of price for a
            // pullback) so we can track how often the LLM produces these vs pullback entries.
            if currentPrice > 0 {
                let isLong = setup.direction == "LONG"
                let entryAboveCurrent = setup.entry > currentPrice
                let isBreakoutLong = isLong && entryAboveCurrent
                let isBreakdownShort = !isLong && !entryAboveCurrent
                if isBreakoutLong {
                    print("[OutcomeTracker] Breakout LONG setup for \(symbol): entry $\(setup.entry) > current $\(currentPrice). Price must rise to enter.")
                } else if isBreakdownShort {
                    print("[OutcomeTracker] Breakdown SHORT setup for \(symbol): entry $\(setup.entry) < current $\(currentPrice). Price must fall to enter.")
                }
            }

            var ts = TrackedSetup(setup: setup, symbol: symbol, analysisId: analysisId,
                                   mlProbability: mlProbability, conviction: conviction,
                                   modelVersion: resolvedModelVersion, setupType: setupType,
                                   priceAtSetup: currentPrice, promptVersion: promptVersion,
                                   archetype: archetype)

            if setupType == .conditional {
                ts.outcome.state = .pending
                ts.outcome.pendingExpiresAt = Date().addingTimeInterval(12 * 3600)
            } else {
                ts.outcome.state = .active
            }

            tracked.insert(ts, at: 0)

            // Cap at 50 per symbol
            if tracked.count > 50 { tracked = Array(tracked.prefix(50)) }

            save(tracked, to: url)

            // Register pending setups with the worker so the cron can fire an
            // "entry zone reached" APN when the latest 4H bar touches entry ± 0.3 × ATR
            // AND ML is still favorable. Fire-and-forget; failures don't block local
            // tracking. Only conditional setups go to the worker — market setups are
            // already at-current-price so there's nothing to wait for.
            if setupType == .conditional, let atr = atrAtRegistration, atr > 0,
               let expiresAt = ts.outcome.pendingExpiresAt {
                Task {
                    await WorkerPendingSetupService.register(
                        setupId: setup.id, symbol: symbol,
                        direction: setup.direction, entry: setup.entry,
                        atr: atr, mlAtRegistration: mlProbability,
                        expiresAt: expiresAt)
                }
            }
        }
    }

    /// Sync resolved outcomes to the worker (D1) for cross-device tracking.
    static func syncResolvedOutcomes(symbol: String) {
        ioQueue.async {
            let url = outcomeDir.appendingPathComponent("setups_\(symbol).json")
            let tracked = loadTrackedSetups(url: url)
            let resolved = tracked.filter { $0.outcome.isCounted && !$0.synced }

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
                        "promptVersion": t.promptVersion,
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

    // MARK: - FLAT/Kill Outcomes

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

    // MARK: - Stats

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

    /// Outcome stats sliced by `promptVersion`. Same definitions as `OutcomeStats`
    /// but keyed by the version string the setup was registered under. Use this
    /// to compare baseline vs treatment populations in the dashboard.
    /// Returns one entry per version found in the lookback window (so versions
    /// with zero setups in the window are omitted from the map).
    static func versionStats(lookbackDays: Int = 30) -> [String: VersionStats] {
        return ioQueue.sync {
            let cutoff = Date().addingTimeInterval(-Double(lookbackDays) * 86400)
            var setupsByVersion: [String: [TrackedSetup]] = [:]

            let dir = outcomeDir
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.lastPathComponent.hasPrefix("setups_") {
                for ts in loadTrackedSetups(url: file) where ts.timestamp >= cutoff {
                    setupsByVersion[ts.promptVersion, default: []].append(ts)
                }
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

    // MARK: - Restore from Server

    /// Fetch resolved outcomes from D1 and merge into local cache.
    static func restoreFromServer() async {
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

                // Restore outcome state — these are already resolved
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

    // MARK: - Cross-Symbol PENDING Scan

    /// Walks every symbol's `setups_*.json` and processes PENDING setups regardless of
    /// which symbol the user is currently analyzing. Catches the case where a PENDING
    /// setup for BTC sits unrefreshed while the user works on ETH — without this, the
    /// BTC entry can touch live, conditions can change, and the re-eval never fires
    /// until the user returns to BTC by which point the trigger is stale.
    ///
    /// Per-symbol behaviour:
    ///   - Timeout check (12h expiry) runs even when no cached AnalysisResult exists.
    ///   - Entry-trigger check needs cached AnalysisResult; falls through silently when
    ///     no recent analysis is available for the symbol.
    ///
    /// Limitation: the cached AnalysisResult for a non-currently-analyzed symbol can be
    /// hours old. Entry triggers fire against cached price data, so a stale cache may
    /// either miss a live touch or trigger on a level the price has long since moved
    /// past. Background price polling would fix this; out of scope here.
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

    static func scanAllPendingSetups() {
        ioQueue.async {
            let dir = outcomeDir
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files {
                guard file.lastPathComponent.hasPrefix("setups_") else { continue }
                let symbol = file.lastPathComponent
                    .replacingOccurrences(of: "setups_", with: "")
                    .replacingOccurrences(of: ".json", with: "")
                var tracked = loadTrackedSetups(url: file)
                guard tracked.contains(where: { $0.outcome.state == .pending }) else { continue }

                let cachedResult = AnalysisHistoryStore.load(symbol: symbol).first
                var changed = false

                for i in tracked.indices {
                    guard tracked[i].outcome.state == .pending else { continue }

                    // Timeout check first — runs without cached data.
                    if let expires = tracked[i].outcome.pendingExpiresAt, Date() > expires {
                        tracked[i].outcome.state = .expired
                        tracked[i].outcome.reEvalResult = ReEvalResult(
                            direction: "", mlWin: nil, killsActive: false,
                            validated: false, reason: "Pending window expired (12h)")
                        changed = true
                        continue
                    }

                    // Entry trigger needs cached price data — skip if no recent analysis.
                    guard let result = cachedResult else { continue }
                    let setup = tracked[i].setup
                    let isLong = setup.direction == "LONG"
                    let currentPrice = result.tf1.price
                    let h1Candles = result.tf3.candles

                    let entryTouched = isLong
                        ? (currentPrice <= setup.entry || h1Candles.contains { $0.low <= setup.entry })
                        : (currentPrice >= setup.entry || h1Candles.contains { $0.high >= setup.entry })

                    if entryTouched {
                        let evalResult = reEvaluate(original: tracked[i], cachedResult: result)
                        tracked[i].outcome.reEvalResult = evalResult
                        if evalResult.validated {
                            tracked[i].outcome.state = .active
                            tracked[i].outcome.entryHit = true
                            tracked[i].outcome.entryHitTime = Date()
                        } else {
                            tracked[i].outcome.state = .invalidated
                        }
                        changed = true
                    }
                }

                if changed { save(tracked, to: file) }
            }
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
    let setupType: SetupType
    /// Live price at the moment the setup was registered. Used by the tracker to choose
    /// the correct entry-detection direction (price must move TOWARD entry from this side).
    /// 0 if missing on legacy stored setups.
    let priceAtSetup: Double
    /// Prompt + system-behavior version snapshot at registration time. See
    /// `OutcomeTracker.currentPromptVersion`. Lets us slice the outcome archive by
    /// system-iteration without conflating the data across material changes.
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
/// from the existing tracked-setup archive — no separate storage, just a
/// `groupBy promptVersion` over the same files `stats()` reads.
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
