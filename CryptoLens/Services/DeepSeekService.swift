import Foundation

/// DeepSeek service — proxies through the worker like Claude/Gemini.
/// R1 (deepseek-reasoner) is the reasoning-tuned variant; V3 (deepseek-chat) is general.
/// Worker normalizes DeepSeek's OpenAI-compatible response into our Claude-shaped envelope.
class DeepSeekService: AIProvider {
    let apiKey: String  // unused — server-side
    let model: String
    var displayName: String { "DeepSeek" }

    private let workerURL = PushService.workerURL

    init(apiKey: String, model: String = "deepseek-reasoner") {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market = .crypto, stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil, positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil, economicEvents: [EconomicEvent] = [], macro: MacroSnapshot? = nil, weeklyContext: String? = nil, spyContext: String? = nil, spotPressure: SpotPressure? = nil, dataQuality: DataQuality? = nil, crossAsset: CrossAssetContext? = nil, outcomeHistory: [(direction: String, entry: Double, outcome: String, mlProb: Double?, conviction: String?)] = []) async throws -> ClaudeAnalysisResponse {
        let prompt = AnalysisPrompt.buildUserPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol, stockInfo: stockInfo, derivatives: derivatives, positioning: positioning, stockSentiment: stockSentiment, economicEvents: economicEvents, macro: macro, weeklyContext: weeklyContext, spyContext: spyContext, spotPressure: spotPressure, dataQuality: dataQuality, crossAsset: crossAsset, outcomeHistory: outcomeHistory)
        let savedParams = ScoringParams.loadSaved(for: market) ?? (market == .crypto ? .cryptoDefault : .stockDefault)
        let system = AnalysisPrompt.systemPrompt(market: market, params: savedParams)

        await PushService.ensureAuth()
        guard let url = URL(string: "\(workerURL)/analyze") else {
            throw DeepSeekError.apiError(0, "Invalid worker URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        // R1's reasoning tokens make responses slow — bump timeout above 60s.
        request.timeoutInterval = 120

        let body: [String: Any] = [
            "model": model,
            "system": system,
            "prompt": prompt,
            "provider": "deepseek",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // DEBUG: dump the exact prompt sent to the AI to /tmp for inspection.
        let dumpDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let dumpURL = dumpDir.appendingPathComponent("last_prompt.txt")
        let dump = "=== SYSTEM PROMPT ===\n\(system)\n\n=== USER PROMPT ===\n\(prompt)\n"
        try? dump.write(to: dumpURL, atomically: true, encoding: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResp = response as? HTTPURLResponse else {
            throw DeepSeekError.decodingError
        }
        if httpResp.statusCode == 429 {
            // Surface the worker's actual error message (e.g. "Max 30 analyses per hour")
            // so the user knows which limit was hit. Fall back to generic if parse fails.
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw DeepSeekError.apiError(429, detail ?? "Rate limited. Try again in a few minutes.")
        }
        guard (200...299).contains(httpResp.statusCode) else {
            let errBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw DeepSeekError.apiError(httpResp.statusCode, errBody)
        }

        // Worker normalizes DeepSeek's OpenAI-shaped response into Claude's envelope:
        // { content: [{ type: "text", text: "..." }] }. We pick the text block.
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]]
        else {
            throw DeepSeekError.decodingError
        }
        let textBlock = content.first(where: { ($0["type"] as? String) == "text" }) ?? content.first
        guard let text = textBlock?["text"] as? String else {
            throw DeepSeekError.decodingError
        }

        let setups = AnalysisPrompt.parseSetups(from: text)
        return ClaudeAnalysisResponse(markdown: text, setups: setups)
    }
}

enum DeepSeekError: LocalizedError {
    case apiError(Int, String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .apiError(let code, let body): return "AI error (\(code)): \(body)"
        case .decodingError: return "Failed to parse AI response"
        }
    }
}
