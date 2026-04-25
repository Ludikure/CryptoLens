import Foundation

class ClaudeService: AIProvider {
    let apiKey: String  // Kept for backward compat but unused when proxied
    let model: String
    var displayName: String { "Claude" }

    private let workerURL = PushService.workerURL

    init(apiKey: String, model: String = Constants.defaultModel) {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market = .crypto, stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil, positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil, economicEvents: [EconomicEvent] = [], macro: MacroSnapshot? = nil, weeklyContext: String? = nil, spyContext: String? = nil, spotPressure: SpotPressure? = nil, dataQuality: DataQuality? = nil, crossAsset: CrossAssetContext? = nil, outcomeHistory: [(direction: String, entry: Double, outcome: String, mlProb: Double?, conviction: String?)] = []) async throws -> ClaudeAnalysisResponse {
        let prompt = AnalysisPrompt.buildUserPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol, stockInfo: stockInfo, derivatives: derivatives, positioning: positioning, stockSentiment: stockSentiment, economicEvents: economicEvents, macro: macro, weeklyContext: weeklyContext, spyContext: spyContext, spotPressure: spotPressure, dataQuality: dataQuality, crossAsset: crossAsset, outcomeHistory: outcomeHistory)
        let savedParams = ScoringParams.loadSaved(for: market) ?? (market == .crypto ? .cryptoDefault : .stockDefault)
        let system = AnalysisPrompt.systemPrompt(market: market, params: savedParams)

        // All AI calls go through the worker proxy — API key stays server-side
        return try await analyzeViaWorker(prompt: prompt, system: system)
    }

    // MARK: - Worker Proxy (production)

    private func analyzeViaWorker(prompt: String, system: String) async throws -> ClaudeAnalysisResponse {
        await PushService.ensureAuth()
        guard let url = URL(string: "\(workerURL)/analyze") else {
            throw ClaudeError.apiError(0, "Invalid worker URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)
        request.timeoutInterval = 60  // AI calls can be slow

        let body: [String: Any] = [
            "model": model,
            "system": system,
            "prompt": prompt,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResp = response as? HTTPURLResponse else {
            throw ClaudeError.decodingError
        }

        if httpResp.statusCode == 401 {
            await PushService.handleAuthFailure()
            throw ClaudeError.apiError(401, "Auth expired. Please retry.")
        }
        if httpResp.statusCode == 429 {
            await MainActor.run { ConnectionStatus.shared.ai = .error }
            throw ClaudeError.apiError(429, "Rate limited. Try again in a few minutes.")
        }
        guard (200...299).contains(httpResp.statusCode) else {
            let errBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            await MainActor.run { ConnectionStatus.shared.ai = .error }
            throw ClaudeError.apiError(httpResp.statusCode, errBody)
        }

        // Worker returns the raw Claude API response
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let first = content.first,
              let text = first["text"] as? String
        else {
            throw ClaudeError.decodingError
        }

        let setups = AnalysisPrompt.parseSetups(from: text)
        await MainActor.run { ConnectionStatus.shared.ai = .ok }
        return ClaudeAnalysisResponse(markdown: text, setups: setups)
    }

    // MARK: - Direct API (fallback / development)

    private func analyzeDirectly(prompt: String, system: String) async throws -> ClaudeAnalysisResponse {
        guard !apiKey.isEmpty, apiKey != "your-key-here" else {
            throw ClaudeError.apiError(0, "API key not configured")
        }
        guard let apiURL = URL(string: Constants.claudeAPIURL) else {
            throw ClaudeError.apiError(0, "Invalid API URL")
        }

        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(Constants.claudeAPIVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 4000,
            "temperature": 0,
            "system": system,
            "messages": [["role": "user", "content": prompt]],
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
                    else { throw ClaudeError.decodingError }
                    let setups = AnalysisPrompt.parseSetups(from: text)
                    return ClaudeAnalysisResponse(markdown: text, setups: setups)
                }
                let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
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
        case .apiError(let code, let body): return "AI error (\(code)): \(body)"
        case .decodingError: return "Failed to parse AI response"
        }
    }
}
