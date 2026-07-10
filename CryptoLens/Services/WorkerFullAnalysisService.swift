import Foundation

/// Calls the Worker `/full-analysis` — the shared analysis brain (indicators + the full
/// pre-computed-flags prompt + LLM, all server-side). This is THE analysis path, unconditional:
/// `AnalysisService.runFullAnalysis` always routes through here (the local Swift prompt builder
/// and the `use_server_analysis` flag were deleted 2026-06-27 — see CLAUDE.md "Dead local-prompt
/// path DELETED").
enum WorkerFullAnalysisService {

    struct Result {
        let markdown: String
        let setups: [TradeSetup]
        let mlWin: Double?
        let mlPersistence: Double?
        let mlDirectionUp: Double?
        let biasDaily: String?
    }

    enum FetchError: LocalizedError {
        case missingURL
        case unauthorized
        case http(Int)
        case decode
        case server(String)

        var errorDescription: String? {
            switch self {
            case .missingURL: return "bad URL"
            case .unauthorized: return "unauthorized"
            case .http(let code): return "HTTP \(code)"
            case .decode: return "bad response"
            case .server(let msg): return msg
            }
        }
    }

    static func analyze(symbol: String, provider: String = "claude", modelID: String = "") async throws -> Result {
        // /full-analysis/async is auth-gated. ensureAuth obtains a token if we have none; a 401
        // self-heals once via handleAuthFailure (rotate deviceId + re-register), matching
        // WorkerMLService so server analysis doesn't dead-end on a stale token.
        await PushService.ensureAuth()
        do {
            return try await runJob(symbol: symbol, provider: provider, modelID: modelID)
        } catch FetchError.unauthorized {
            await PushService.handleAuthFailure()
            return try await runJob(symbol: symbol, provider: provider, modelID: modelID)
        }
    }

    /// Fire-and-forget: start (or resume) a detached analysis job on the box and poll for the
    /// result. The box runs the ~30-90s pipeline independent of the phone, so a screen-lock /
    /// app-suspend can't kill it — each poll is a short request, and while the app is frozen the
    /// box keeps working; on resume the next poll returns the finished result. If the app was
    /// force-killed, `pendingJob(for:)` lets a later call RESUME the same job (no second LLM spend).
    private static func runJob(symbol: String, provider: String, modelID: String) async throws -> Result {
        var jobId: String
        if let existing = pendingJob(for: symbol) {
            jobId = existing
        } else {
            jobId = try await startAsyncJob(symbol: symbol, provider: provider, modelID: modelID)
            storePendingJob(jobId, symbol: symbol)
        }

        let deadline = Date().addingTimeInterval(180)   // generous — covers a slow extended-thinking run
        var transientStreak = 0
        var restarted = false
        while Date() < deadline {
            do {
                switch try await pollResult(jobId: jobId) {
                case .pending:
                    transientStreak = 0
                case .done(let r):
                    clearPendingJob(symbol: symbol)
                    return r
                case .failed(let msg):
                    clearPendingJob(symbol: symbol)
                    throw FetchError.server(msg)
                case .expired:
                    // Job fell out of the box's KV (restart or >1h). Restart once, else give up.
                    clearPendingJob(symbol: symbol)
                    guard !restarted else { throw FetchError.server("Analysis job expired") }
                    restarted = true
                    jobId = try await startAsyncJob(symbol: symbol, provider: provider, modelID: modelID)
                    storePendingJob(jobId, symbol: symbol)
                }
            } catch let e where isTransient(e) {
                transientStreak += 1
                if transientStreak > 10 { throw e }   // ~30s of continuous failures → surface it
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)   // poll every 3s
        }
        // The wall-clock deadline also elapses while the app is SUSPENDED (the task is frozen,
        // not polling) — so on resume the loop can exit with the finished result sitting in the
        // box's KV. One final poll before declaring a timeout; this is the normal path for a
        // long screen-lock, not an edge case.
        if case .done(let r) = try await pollResult(jobId: jobId) {
            clearPendingJob(symbol: symbol)
            return r
        }
        throw FetchError.server("Analysis timed out")
    }

    private static func isTransient(_ error: Error) -> Bool {
        if case FetchError.http(0) = error { return true }
        // 429 on a POLL is the device's global rate budget momentarily exhausted (refresh cycle +
        // polling overlap) — the box job is still running; keep polling instead of failing the UI.
        if case FetchError.http(429) = error { return true }
        if let urlErr = error as? URLError {
            switch urlErr.code {
            case .networkConnectionLost, .timedOut, .cannotConnectToHost,
                 .notConnectedToInternet, .cannotFindHost, .dnsLookupFailed:
                return true
            default: return false
            }
        }
        return false
    }

    /// The `/full-analysis` endpoint URL.
    static var endpointURL: URL? { URL(string: "\(PushService.workerURL)/full-analysis") }

    /// Assemble the POST body shared by the foreground and background paths (provider/model,
    /// position sizing, active tracked trades). `async` only because it reads OutcomeTracker.
    static func buildBody(symbol: String, provider: String, modelID: String) async -> [String: Any] {
        // Position-sizing inputs (same UserDefaults the local prompt reads) so the server's
        // CANDIDATE SETUPS sizing matches the user's risk plan.
        var bodyDict: [String: Any] = ["symbol": symbol]

        // Provider + model selection (Settings picker). Split the iOS "@thinking-N" model-id suffix
        // into the clean model the worker allowlists + a separate thinkingBudget (Claude only). For
        // a Claude model with no suffix, send 0 to disable thinking explicitly (else the worker
        // defaults to 8000); Gemini/DeepSeek ignore thinkingBudget.
        bodyDict["provider"] = provider
        if !modelID.isEmpty {
            if let r = modelID.range(of: "@thinking-") {
                bodyDict["model"] = String(modelID[..<r.lowerBound])
                if let budget = Int(modelID[r.upperBound...]) { bodyDict["thinkingBudget"] = budget }
            } else {
                bodyDict["model"] = modelID
                if provider == "claude" { bodyDict["thinkingBudget"] = 0 }
            }
        }
        let acct = UserDefaults.standard.double(forKey: "accountSize")
        let risk = UserDefaults.standard.double(forKey: "riskPercent")
        if acct > 0 { bodyDict["accountSize"] = acct }
        if risk > 0 { bodyDict["riskPercent"] = risk }

        // Active tracked trades (Active Trade State / C8) — the one input the worker can't
        // know on its own. Send the same subset the local prompt uses (active + entry hit)
        // so the server emits an identical "manage this trade" section.
        let active = await OutcomeTracker.activeSetupsAsync(symbol: symbol).filter {
            $0.outcome.state == .active && $0.outcome.entryHit
        }
        let activeJSON: [[String: Any]] = active.compactMap { t in
            guard let entryTime = t.outcome.entryHitTime, t.setup.entry > 0, t.setup.risk > 0 else { return nil }
            var dict: [String: Any] = [
                "direction": t.setup.direction,
                "entry": t.setup.entry,
                "risk": t.setup.risk,
                "tp1": t.setup.tp1,
                "entryHitTimeMs": entryTime.timeIntervalSince1970 * 1000,
                "maxFavorable": t.outcome.maxFavorable,
                "maxAdverse": t.outcome.maxAdverse,
                "tp1Hit": t.outcome.tp1Hit,
                "partialTaken": t.outcome.partialTaken,
                "breakevenActivated": t.outcome.breakevenActivated,
            ]
            if let ml = t.mlProbability { dict["mlProbability"] = ml }
            return dict
        }
        if !activeJSON.isEmpty { bodyDict["activeSetups"] = activeJSON }
        return bodyDict
    }

    /// Validate an HTTP status + decode the `/full-analysis` response into a `Result`.
    /// Shared by the foreground and background paths. Throws `.unauthorized` on 401 so the
    /// caller can self-heal once.
    static func parse(status: Int, data: Data) throws -> Result {
        if status == 401 { throw FetchError.unauthorized }
        guard (200..<300).contains(status) else {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = obj["error"] as? String {
                throw FetchError.server(err)
            }
            throw FetchError.http(status)
        }
        struct Body: Decodable {
            let analysis: String
            let setups: [TradeSetup]
            struct ML: Decodable { let win: Double?; let persistence: Double?; let directionUp: Double? }
            let ml: ML?
            struct Bias: Decodable { let daily: String? }
            let bias: Bias?
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { throw FetchError.decode }
        return Result(
            markdown: body.analysis,
            setups: body.setups,
            mlWin: body.ml?.win,
            mlPersistence: body.ml?.persistence,
            mlDirectionUp: body.ml?.directionUp,
            biasDaily: body.bias?.daily
        )
    }

    // MARK: - Async job (fire-and-forget)

    private enum PollOutcome { case pending; case done(Result); case failed(String); case expired }

    /// POST /full-analysis/async → returns the jobId. Short request; the heavy work is detached.
    private static func startAsyncJob(symbol: String, provider: String, modelID: String) async throws -> String {
        guard let url = URL(string: "\(PushService.workerURL)/full-analysis/async") else { throw FetchError.missingURL }
        let bodyDict = await buildBody(symbol: symbol, provider: provider, modelID: modelID)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        if http.statusCode == 401 { throw FetchError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = obj["error"] as? String { throw FetchError.server(err) }
            throw FetchError.http(http.statusCode)
        }
        struct Started: Decodable { let jobId: String }
        guard let s = try? JSONDecoder().decode(Started.self, from: data) else { throw FetchError.decode }
        return s.jobId
    }

    /// GET /full-analysis/result?jobId= → pending / done / failed / expired. The `result` field of a
    /// done job is the same shape as the sync /full-analysis body, so it reuses `parse`.
    private static func pollResult(jobId: String) async throws -> PollOutcome {
        guard let url = URL(string: "\(PushService.workerURL)/full-analysis/result?jobId=\(jobId)") else { throw FetchError.missingURL }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        PushService.addAuthHeaders(&request)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        if http.statusCode == 401 { throw FetchError.unauthorized }
        if http.statusCode == 404 { return .expired }
        guard (200..<300).contains(http.statusCode) else { throw FetchError.http(http.statusCode) }
        struct Envelope: Decodable { let status: String; let error: String? }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else { throw FetchError.decode }
        switch env.status {
        case "done":
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let result = obj["result"],
                  let rdata = try? JSONSerialization.data(withJSONObject: result) else { throw FetchError.decode }
            return .done(try parse(status: 200, data: rdata))
        case "error": return .failed(env.error ?? "Analysis failed")
        case "expired": return .expired
        default: return .pending
        }
    }

    // MARK: - Pending-job persistence (survives app kill → resume without a second LLM spend)

    private static func jobKey(_ symbol: String) -> String { "pending_analysis_job_\(symbol)" }

    /// An in-flight (or finished-but-unclaimed) jobId for this symbol, if any. The retention
    /// window matches the box's KV job TTL (3600s) — pre-2026-07-01 this pruned at 180s, which
    /// defeated the whole fire-and-forget design: tapping the "analysis ready" push more than
    /// 3 minutes after starting found no job to resume and re-ran the analysis (double LLM spend).
    static func pendingJob(for symbol: String) -> String? {
        let d = UserDefaults.standard
        guard let jid = d.string(forKey: jobKey(symbol)) else { return nil }
        if Date().timeIntervalSince1970 - d.double(forKey: jobKey(symbol) + "_at") > 3600 {
            clearPendingJob(symbol: symbol); return nil
        }
        return jid
    }

    /// Whether a resumable analysis job is outstanding for this symbol (drives foreground recovery).
    static func hasPendingJob(for symbol: String) -> Bool { pendingJob(for: symbol) != nil }

    /// All symbols with a recent outstanding job — lets foreground recovery resume jobs even when
    /// the app cold-launched (currentSymbol not yet set) or the user switched symbols before the
    /// job finished. Prunes stale keys as a side effect.
    static func pendingJobSymbols() -> [String] {
        let prefix = "pending_analysis_job_"
        return UserDefaults.standard.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(prefix) && !$0.hasSuffix("_at") }
            .map { String($0.dropFirst(prefix.count)) }
            .filter { hasPendingJob(for: $0) }
    }

    private static func storePendingJob(_ jobId: String, symbol: String) {
        let d = UserDefaults.standard
        d.set(jobId, forKey: jobKey(symbol))
        d.set(Date().timeIntervalSince1970, forKey: jobKey(symbol) + "_at")
    }

    private static func clearPendingJob(symbol: String) {
        let d = UserDefaults.standard
        d.removeObject(forKey: jobKey(symbol))
        d.removeObject(forKey: jobKey(symbol) + "_at")
    }
}
