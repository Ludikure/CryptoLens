import Foundation

class ClaudeService {
    let apiKey: String
    let model: String

    init(apiKey: String, model: String = Constants.defaultModel) {
        self.apiKey = apiKey
        self.model = model
    }

    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String) async throws -> ClaudeAnalysisResponse {
        let prompt = buildPrompt(indicators: indicators, sentiment: sentiment, symbol: symbol)

        var request = URLRequest(url: URL(string: Constants.claudeAPIURL)!)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(Constants.claudeAPIVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 2500,
            "system": systemPrompt,
            "messages": [
                ["role": "user", "content": prompt]
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // Retry up to 3 times for transient errors (429, 529, 500+)
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
                    let setups = parseSetups(from: text)
                    return ClaudeAnalysisResponse(markdown: text, setups: setups)
                }

                let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
                print("[CryptoLens] Claude API \(code) (attempt \(attempt + 1)): \(errorBody)")

                // Retry on overloaded/rate-limit/server errors
                if code == 429 || code == 529 || code >= 500 {
                    lastError = ClaudeError.apiError(code, errorBody)
                    continue
                }
                throw ClaudeError.apiError(code, errorBody)
            }
        }
        throw lastError
    }

    // MARK: - Parse structured setups from Claude's response

    /// Extract trade setups from the JSON block in Claude's response.
    private func parseSetups(from text: String) -> [TradeSetup] {
        // Look for ```json ... ``` block at the end
        guard let jsonStart = text.range(of: "```json\n"),
              let jsonEnd = text.range(of: "\n```", range: jsonStart.upperBound..<text.endIndex)
        else { return [] }

        let jsonString = String(text[jsonStart.upperBound..<jsonEnd.lowerBound])
        guard let data = jsonString.data(using: .utf8) else { return [] }

        do {
            return try JSONDecoder().decode([TradeSetup].self, from: data)
        } catch {
            print("[CryptoLens] Setup parse failed: \(error)")
            return []
        }
    }

    // MARK: - Prompts

    private let systemPrompt = """
    You are a crypto technical analyst. You receive pre-computed indicator data across three timeframes (Daily for trend, 4H for directional bias, 1H for entries).

    Your job:
    1. SYNTHESIZE the data — what story are the indicators telling across timeframes? Note divergences between timeframes. Call out what's noise vs what matters.

    2. BUILD TRADE SETUPS — construct both a long and short scenario using S/R levels, fib levels, ATR, volume, and cross-timeframe context. For each provide:
       - Entry price and reasoning
       - Stop loss and reasoning
       - TP1, TP2, TP3 with R:R ratios
       - Volume assessment
       - Trigger conditions
       Present each setup as a table with Entry, SL, TP1, TP2, TP3 rows showing Price, Distance, and R:R.

    3. STATE YOUR BIAS — LONG, SHORT, or NEUTRAL with one line of reasoning.

    4. STRUCTURED OUTPUT — At the very end of your response, include a JSON block with the trade setups in this exact format:
    ```json
    [
      {"direction": "LONG", "entry": 65000.0, "stopLoss": 63500.0, "tp1": 67000.0, "tp2": 69000.0, "tp3": 72000.0, "reasoning": "Brief reason"},
      {"direction": "SHORT", "entry": 66500.0, "stopLoss": 68000.0, "tp1": 64000.0, "tp2": 62000.0, "tp3": 60000.0, "reasoning": "Brief reason"}
    ]
    ```
    Use actual computed prices from the data. This JSON is machine-parsed to create price alerts.

    Think like a trader. Use the actual indicator values and levels provided. Do NOT make up numbers. Be direct — no hedging.
    """

    private func buildPrompt(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String) -> String {
        var lines = ["Symbol: \(symbol)"]

        if let s = sentiment {
            lines.append("Sentiment: 24h: \(Formatters.formatPercent(s.priceChangePercentage24h)), 7d: \(Formatters.formatPercent(s.priceChangePercentage7d)), 30d: \(Formatters.formatPercent(s.priceChangePercentage30d)), ATH distance: \(Formatters.formatPercent(s.athChangePercentage))")
        }
        lines.append("")

        for ind in indicators {
            lines.append("=== \(ind.label) ===")
            lines.append("Price: \(Formatters.formatPrice(ind.price)) | Bias: \(ind.bias) (\(Int(ind.bullPercent))% bullish)")

            if let rsi = ind.rsi {
                var rsiStr = "RSI: \(rsi)"
                if let sr = ind.stochRSI { rsiStr += " | Stoch RSI: \(sr.k)/\(sr.d)" }
                lines.append(rsiStr)
            }
            if let macd = ind.macd {
                lines.append("MACD: \(macd.macd) Signal: \(macd.signal) Hist: \(macd.histogram)\(macd.crossover.map { " Crossover: \($0)" } ?? "")")
            }
            if let adx = ind.adx {
                lines.append("ADX: \(adx.adx) (\(adx.strength), \(adx.direction)) +DI: \(adx.plusDI) -DI: \(adx.minusDI)")
            }
            if let bb = ind.bollingerBands {
                lines.append("BB: %B \(bb.percentB), BW \(bb.bandwidth)%\(bb.squeeze ? " SQUEEZE" : "")")
            }
            if let atr = ind.atr {
                lines.append("ATR: \(Formatters.formatPrice(atr.atr)) (\(atr.atrPercent)%)")
            }

            var maParts = [String]()
            if let e20 = ind.ema20 { maParts.append("EMA20=\(Formatters.formatPrice(e20))") }
            if let e50 = ind.ema50 { maParts.append("EMA50=\(Formatters.formatPrice(e50))") }
            if let e200 = ind.ema200 { maParts.append("EMA200=\(Formatters.formatPrice(e200))") }
            if !maParts.isEmpty { lines.append("MAs: \(maParts.joined(separator: " "))") }

            if let e20 = ind.ema20, let e50 = ind.ema50, let e200 = ind.ema200 {
                if e20 > e50 && e50 > e200 { lines.append("Structure: Bullish (20 > 50 > 200)") }
                else if e20 < e50 && e50 < e200 { lines.append("Structure: Bearish (20 < 50 < 200)") }
                else { lines.append("Structure: Mixed") }
            }

            if let vwap = ind.vwap {
                lines.append("VWAP: \(Formatters.formatPrice(vwap.vwap)) (\(vwap.priceVsVwap), \(Formatters.formatPercent(vwap.distancePercent)))")
            }
            if let vol = ind.volumeRatio { lines.append("Volume: \(vol)x avg") }

            if !ind.supportResistance.supports.isEmpty {
                lines.append("Support: \(ind.supportResistance.supports.map { Formatters.formatPrice($0) }.joined(separator: ", "))")
            }
            if !ind.supportResistance.resistances.isEmpty {
                lines.append("Resistance: \(ind.supportResistance.resistances.map { Formatters.formatPrice($0) }.joined(separator: ", "))")
            }

            if let fib = ind.fibonacci {
                lines.append("Fib (\(fib.trend)): swing \(Formatters.formatPrice(fib.swingLow))-\(Formatters.formatPrice(fib.swingHigh)) | Nearest: \(fib.nearestLevel) at \(Formatters.formatPrice(fib.nearestPrice))")
            }

            if let div = ind.divergence { lines.append("Divergence: \(div)") }
            if !ind.candlePatterns.isEmpty {
                lines.append("Patterns: \(ind.candlePatterns.map(\.pattern).joined(separator: ", "))")
            }
            lines.append("")
        }

        // Order setups by bias
        let avgBull = indicators.map(\.bullPercent).reduce(0, +) / Double(indicators.count)
        if avgBull <= 40 {
            lines.append("INSTRUCTION: Overall bias is bearish. Present the SHORT trade setup FIRST, then the long setup.")
        } else if avgBull >= 60 {
            lines.append("INSTRUCTION: Overall bias is bullish. Present the LONG trade setup FIRST, then the short setup.")
        }

        return lines.joined(separator: "\n")
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
