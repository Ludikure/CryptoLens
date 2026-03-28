import Foundation

class GeminiService: AIProvider {
    let apiKey: String
    let model: String
    var displayName: String { "Gemini" }

    init(apiKey: String, model: String = "gemini-2.5-flash") {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market = .crypto, stockInfo: StockInfo? = nil) async throws -> ClaudeAnalysisResponse {
        let prompt = AnalysisPrompt.buildUserPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol, stockInfo: stockInfo)

        let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent?key=\(apiKey)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "system_instruction": ["parts": [["text": AnalysisPrompt.systemPrompt(market: market)]]],
            "contents": [
                ["parts": [["text": prompt]]]
            ],
            "generationConfig": [
                "maxOutputTokens": 2500,
                "temperature": 0.2,
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // Retry for transient errors
        var lastError: Error = GeminiError.decodingError
        for attempt in 0..<3 {
            if attempt > 0 {
                try await Task.sleep(for: .seconds(Double(attempt) * 2))
            }

            let (data, response) = try await URLSession.shared.data(for: request)

            if let httpResponse = response as? HTTPURLResponse {
                let code = httpResponse.statusCode
                if (200...299).contains(code) {
                    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let candidates = json["candidates"] as? [[String: Any]],
                          let first = candidates.first,
                          let content = first["content"] as? [String: Any],
                          let parts = content["parts"] as? [[String: Any]],
                          let text = parts.first?["text"] as? String
                    else {
                        throw GeminiError.decodingError
                    }
                    let setups = AnalysisPrompt.parseSetups(from: text)
                    return ClaudeAnalysisResponse(markdown: text, setups: setups)
                }

                let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
                print("[MarketScope] Gemini API \(code) (attempt \(attempt + 1)): \(errorBody)")

                if code == 429 || code >= 500 {
                    lastError = GeminiError.apiError(code, errorBody)
                    continue
                }
                throw GeminiError.apiError(code, errorBody)
            }
        }
        throw lastError
    }
}

enum GeminiError: LocalizedError {
    case apiError(Int, String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .apiError(let code, let body): return "Gemini API error (\(code)): \(body)"
        case .decodingError: return "Failed to parse Gemini response"
        }
    }
}
