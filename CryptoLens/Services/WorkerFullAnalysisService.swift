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

    static func analyze(symbol: String) async throws -> Result {
        // /full-analysis is auth-gated. ensureAuth obtains a token if we have none; a 401
        // self-heals once via handleAuthFailure (rotate deviceId + re-register), matching
        // WorkerMLService so server analysis doesn't dead-end on a stale token.
        await PushService.ensureAuth()
        do {
            return try await post(symbol: symbol)
        } catch FetchError.unauthorized {
            await PushService.handleAuthFailure()
            return try await post(symbol: symbol)
        }
    }

    private static func post(symbol: String) async throws -> Result {
        guard let url = URL(string: "\(PushService.workerURL)/full-analysis") else { throw FetchError.missingURL }

        // Position-sizing inputs (same UserDefaults the local prompt reads) so the server's
        // CANDIDATE SETUPS sizing matches the user's risk plan. thinkingBudget is omitted →
        // the worker defaults to 8000 (Sonnet + extended thinking).
        var bodyDict: [String: Any] = ["symbol": symbol]
        let acct = UserDefaults.standard.double(forKey: "accountSize")
        let risk = UserDefaults.standard.double(forKey: "riskPercent")
        if acct > 0 { bodyDict["accountSize"] = acct }
        if risk > 0 { bodyDict["riskPercent"] = risk }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120   // extended thinking can take ~60s
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        if http.statusCode == 401 { throw FetchError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = obj["error"] as? String {
                throw FetchError.server(err)
            }
            throw FetchError.http(http.statusCode)
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
}
