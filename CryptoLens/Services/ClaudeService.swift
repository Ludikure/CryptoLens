import Foundation

class ClaudeService: AIProvider {
    let apiKey: String
    let model: String
    var displayName: String { "Claude" }

    init(apiKey: String, model: String = Constants.defaultModel) {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market = .crypto, stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil, positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil) async throws -> ClaudeAnalysisResponse {
        let prompt = AnalysisPrompt.buildUserPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol, stockInfo: stockInfo, derivatives: derivatives, positioning: positioning, stockSentiment: stockSentiment)

        var request = URLRequest(url: URL(string: Constants.claudeAPIURL)!)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(Constants.claudeAPIVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 2500,
            "temperature": 0,
            "system": AnalysisPrompt.systemPrompt(market: market),
            "messages": [
                ["role": "user", "content": prompt]
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        var lastError: Error = ClaudeError.decodingError
        for attempt in 0..<3 {
            if attempt > 0 {
                try await Task.sleep(for: .seconds(Double(attempt) * 2))
            }

            let (data, response) = try await URLSession.shared.data(for: request)

            if let httpResponse = response as? HTTPURLResponse {
                let code = httpResponse.statusCode
                if (200...299).contains(code) {
                    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let content = json["content"] as? [[String: Any]],
                          let first = content.first,
                          let text = first["text"] as? String
                    else {
                        throw ClaudeError.decodingError
                    }
                    let setups = AnalysisPrompt.parseSetups(from: text)
                    return ClaudeAnalysisResponse(markdown: text, setups: setups)
                }

                let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
                print("[MarketScope] Claude API \(code) (attempt \(attempt + 1)): \(errorBody)")

                if code == 429 || code == 529 || code >= 500 {
                    lastError = ClaudeError.apiError(code, errorBody)
                    continue
                }
                throw ClaudeError.apiError(code, errorBody)
            }
        }
        throw lastError
    }
}

enum ClaudeError: LocalizedError {
    case apiError(Int, String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .apiError(let code, let body): return "Claude API error (\(code)): \(body)"
        case .decodingError: return "Failed to parse Claude response"
        }
    }
}
