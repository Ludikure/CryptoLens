import Foundation

/// Calls the Worker `/full-analysis` — the shared analysis brain (indicators + the full
/// pre-computed-flags prompt + LLM, all server-side). This is the Phase-4 migration path:
/// when the `use_server_analysis` UserDefault is ON, `AnalysisService.runFullAnalysis` uses
/// this instead of building the ~2,700-line prompt locally via `AnalysisPrompt.buildUserPrompt`
/// and calling `/analyze`. Server uses Claude Sonnet + extended thinking.
///
/// Step 1 is intentionally side-by-side + flag-gated (default OFF) so the server output can be
/// compared against the local engine before the Swift prompt builder is retired. The local
/// indicator engine still runs for the chart/table + outcome tracking; only the prompt + LLM
/// call move server-side here.
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
        // /full-analysis is auth-gated. ensureAuth obtains a token if we have none; a 401
        // self-heals once via handleAuthFailure (rotate deviceId + re-register), matching
        // WorkerMLService so server analysis doesn't dead-end on a stale token.
        await PushService.ensureAuth()
        do {
            return try await post(symbol: symbol, provider: provider, modelID: modelID)
        } catch FetchError.unauthorized {
            await PushService.handleAuthFailure()
            return try await post(symbol: symbol, provider: provider, modelID: modelID)
        }
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

    private static func post(symbol: String, provider: String, modelID: String) async throws -> Result {
        guard let url = endpointURL else { throw FetchError.missingURL }
        let bodyDict = await buildBody(symbol: symbol, provider: provider, modelID: modelID)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120   // extended thinking can take ~60s
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        return try parse(status: http.statusCode, data: data)
    }
}
