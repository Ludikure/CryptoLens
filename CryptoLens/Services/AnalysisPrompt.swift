import Foundation

/// Shared prompt construction and response parsing for all AI providers.
enum AnalysisPrompt {

    static func systemPrompt(market: Market = .crypto) -> String {
        let base = """
        You are a technical analyst. You receive pre-computed indicator data across three timeframes.

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

        switch market {
        case .crypto:
            return base + """

            CRYPTO-SPECIFIC CONTEXT:
            - This is crypto, trading 24/7 with no market hours.
            - Timeframes: Daily (trend), 4H (directional bias), 1H (entry).
            """
        case .stock:
            return base + """

            STOCK-SPECIFIC CONTEXT:
            - This is a stock/ETF. Market hours are 9:30 AM - 4 PM ET.
            - Overnight gaps are normal — factor them into S/R analysis.
            - Volume follows a U-shape intraday: high at open/close, low midday.
            - If fundamentals are provided (P/E, earnings date), factor them in.
            - Prices may be 15-minute delayed.
            - Timeframes: Daily (trend), 1H (bias), 15m (entry).
            """
        }
    }

    // Keep backward-compatible static for existing code
    static let systemPrompt = systemPrompt(market: .crypto)

    static func buildUserPrompt(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, stockInfo: StockInfo? = nil) -> String {
        var lines = ["Symbol: \(symbol)"]

        if let s = sentiment {
            lines.append("Sentiment: 24h: \(Formatters.formatPercent(s.priceChangePercentage24h)), 7d: \(Formatters.formatPercent(s.priceChangePercentage7d)), 30d: \(Formatters.formatPercent(s.priceChangePercentage30d)), ATH distance: \(Formatters.formatPercent(s.athChangePercentage))")
        }

        if let si = stockInfo {
            var parts = [String]()
            if let pe = si.peRatio { parts.append("P/E: \(String(format: "%.1f", pe))") }
            if let eps = si.eps { parts.append("EPS: $\(String(format: "%.2f", eps))") }
            if let div = si.dividendYield { parts.append("Div Yield: \(String(format: "%.2f%%", div))") }
            parts.append("52w: \(Formatters.formatPrice(si.fiftyTwoWeekLow)) – \(Formatters.formatPrice(si.fiftyTwoWeekHigh))")
            if let sector = si.sector { parts.append("Sector: \(sector)") }
            parts.append("Market: \(si.marketState)")
            lines.append("Fundamentals: \(parts.joined(separator: " | "))")
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

            // Stock-only indicators
            if let obv = ind.obv {
                lines.append("OBV: \(obv.trend)\(obv.divergence.map { " — \($0)" } ?? "")")
            }
            if let ad = ind.adLine {
                lines.append("A/D Line: \(ad.trend)")
            }
            if let cross = ind.smaCross {
                lines.append("SMA Cross: \(cross.status)\(cross.recentCross.map { " — \($0)" } ?? "")")
            }
            if let gap = ind.gap {
                lines.append("Gap: \(gap.direction) \(Formatters.formatPercent(gap.gapPercent)) from \(Formatters.formatPrice(gap.previousClose))\(gap.filled ? " (FILLED)" : "")")
            }
            if let addv = ind.addv {
                lines.append("ADDV: \(Formatters.formatVolume(addv.averageDollarVolume)) (\(addv.liquidity))")
            }

            lines.append("")
        }

        let avgBull = indicators.map(\.bullPercent).reduce(0, +) / Double(indicators.count)
        if avgBull <= 40 {
            lines.append("INSTRUCTION: Overall bias is bearish. Present the SHORT trade setup FIRST, then the long setup.")
        } else if avgBull >= 60 {
            lines.append("INSTRUCTION: Overall bias is bullish. Present the LONG trade setup FIRST, then the short setup.")
        }

        return lines.joined(separator: "\n")
    }

    /// Extract trade setups from the ```json block in the response.
    static func parseSetups(from text: String) -> [TradeSetup] {
        guard let jsonStart = text.range(of: "```json\n"),
              let jsonEnd = text.range(of: "\n```", range: jsonStart.upperBound..<text.endIndex)
        else { return [] }

        let jsonString = String(text[jsonStart.upperBound..<jsonEnd.lowerBound])
        guard let data = jsonString.data(using: .utf8) else { return [] }

        do {
            return try JSONDecoder().decode([TradeSetup].self, from: data)
        } catch {
            print("[MarketLens] Setup parse failed: \(error)")
            return []
        }
    }
}
