import Foundation

class GeminiService: AIProvider {
    let apiKey: String  // Unused — kept for protocol compat
    let model: String
    var displayName: String { "Gemini" }

    private let workerURL = PushService.workerURL

    init(apiKey: String, model: String = "gemini-2.5-flash") {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market = .crypto, stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil, positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil, economicEvents: [EconomicEvent] = [], macro: MacroSnapshot? = nil) async throws -> ClaudeAnalysisResponse {
        let prompt = AnalysisPrompt.buildUserPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol, stockInfo: stockInfo, derivatives: derivatives, positioning: positioning, stockSentiment: stockSentiment, economicEvents: economicEvents, macro: macro)
        let system = AnalysisPrompt.systemPrompt(market: market)

        // Route through worker proxy — API key stays server-side
        await PushService.ensureAuth()
        guard let url = URL(string: "\(workerURL)/analyze") else {
            throw GeminiError.apiError(0, "Invalid worker URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        request.timeoutInterval = 60

        let body: [String: Any] = [
            "model": model,
            "system": system,
            "prompt": prompt,
            "provider": "gemini",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResp = response as? HTTPURLResponse else {
            throw GeminiError.decodingError
        }
        if httpResp.statusCode == 429 {
            throw GeminiError.apiError(429, "Rate limited. Try again in a few minutes.")
        }
        guard (200...299).contains(httpResp.statusCode) else {
            let errBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw GeminiError.apiError(httpResp.statusCode, errBody)
        }

        // Worker returns the raw provider response
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let first = content.first,
              let text = first["text"] as? String
        else {
            throw GeminiError.decodingError
        }

        let setups = AnalysisPrompt.parseSetups(from: text)
        return ClaudeAnalysisResponse(markdown: text, setups: setups)
    }
}

enum GeminiError: LocalizedError {
    case apiError(Int, String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .apiError(let code, let body): return "AI error (\(code)): \(body)"
        case .decodingError: return "Failed to parse AI response"
        }
    }
}
