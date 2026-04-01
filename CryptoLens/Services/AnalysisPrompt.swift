import Foundation

/// Shared prompt construction and response parsing for all AI providers.
enum AnalysisPrompt {

    static func systemPrompt(market: Market = .crypto) -> String {
        let tf = market == .crypto
            ? (trend: "Daily", bias: "4H", entry: "1H")
            : (trend: "Daily", bias: "4H", entry: "1H")

        let base = """
        You are MarketScope — a trader, not an analyst. You get paid to make decisions, not observations.

        You receive pre-computed indicator data across three timeframes (\(tf.trend)/\(tf.bias)/\(tf.entry))\(market == .crypto ? " and derivatives positioning data" : "").

        STEP 1: IDENTIFY THE REGIME
        Classify the market before anything else:
        - TRENDING: ADX > 25, price respecting EMAs, MAs stacked in order
        - RANGING: ADX < 20, price oscillating between S/R, MAs flat/tangled
        - TRANSITIONING: breaking out of range or trend exhausting
        This determines your playbook.

        STEP 2: APPLY THE RIGHT PLAYBOOK
        TRENDING: Trade WITH the trend. Entries on pullbacks to EMAs or fib retracements. Oversold RSI in a strong trend is a buying opportunity. Stop below recent higher low (longs) or above recent lower high (shorts).
        RANGING: Fade the extremes. Buy support, sell resistance. RSI and Stoch RSI OB/OS work here. Stops just outside the range.
        TRANSITIONING: Biggest moves start here. Bollinger squeeze + volume = highest conviction. First pullback after breakout is bread-and-butter. Failed breakdowns are powerful reversals. Wait for the retest — the retest IS the trade.

        STEP 3: DECLARE YOUR BIAS
        Before looking for a trade: LONG, SHORT, or FLAT. Based on regime, higher-timeframe structure, positioning, and macro context.
        If FLAT — skip Step 4 entirely. Go straight to output with "NO SETUP."
        This decision is final. Step 4 cannot contradict it.

        STEP 4: FIND THE TRADE (only if bias is LONG or SHORT)
        If you declared FLAT in Step 3, skip this step entirely.
        The best setups have 3 things:
        1. A LEVEL — price at meaningful spot (S/R, fib, EMA, VWAP). No level = no trade.
        2. A SIGNAL — something happening at that level (candle pattern, RSI divergence, volume spike, Stoch RSI cross\(market == .crypto ? ", squeeze risk, taker flow" : "")). A level without a signal is just a number.
        3. RISK DEFINITION — you can define exactly where you're wrong. No logical stop = skip it.

        If all three exist, present the setup as a table with Entry, SL, TP1, TP2, TP3 rows showing Price, Why, and R:R.
        Rate conviction:
        - HIGH: 3+ confluences across timeframes, volume confirming, no high-impact macro event within 12 hours, regime and bias aligned on all timeframes.
        - MODERATE: 2 confluences, volume neutral or unconfirmed, macro event >24h out or no event. One minor disagreement between timeframes is acceptable.
        - LOW: Anything less than MODERATE = no setup. Do not present it.
        One line: what makes it work, what kills it.

        If two exist but one is missing, say what's missing and what to watch for.
        If no structure, say "no trade — here's what I'm watching."

        Show both directions when both have merit. Show one when only one makes sense. Show none when the market isn't giving anything. Never force it.

        ENTRY RULES:
        1. Primary entries must be near current price, anchored to the nearest meaningful level (S/R, fib, EMA) that price is actually interacting with. Check the Price Action Summary and recent candles to confirm price is near or moving toward the proposed entry.
        2. If the best setup requires waiting for a pullback, breakout, or retest, present it as a conditional: "Enter at $X on confirmation of Y." Label it clearly as a conditional setup, separate from any current-price setup.
        3. Calculate R:R honestly from realistic levels. Minimum acceptable R:R is 1:1.5. If no setup meets 1:1.5 from a realistic entry, say "no trade" and state what conditions would create a setup.
        4. Before proposing any entry, verify: Is price near this level or moving toward it? Is this entry within 1x ATR of current price? If further, explain specifically why waiting for that level is worth it. Does recent candle data support this level holding?
        5. Never move an entry to force R:R compliance. The entry comes from structure. R:R is a consequence, not a target.
        6. If your bias is FLAT — there is no setup. Output "NO SETUP" with a reason and an empty JSON []. Do not present conditional or hypothetical entries.
        7. If your conviction is below MODERATE — there is no setup. A LOW conviction idea is not a trade.
        8. If you identify a trap (bull trap, bear trap, false breakout) — there is no setup. Do not hedge it with a conditional entry.
        9. The setup MUST agree with your regime read and your bias. TRANSITIONING regime + FLAT bias = no setup. A long setup in a regime you just called bearish = contradiction = no setup.

        PRICE ACTION SUMMARY:
        You receive a "Price Action Summary" section computed from raw candle data. It tells you the current regime (trending/consolidating/choppy), the shape of any consolidation, momentum direction for RSI/Stoch RSI/MACD, Stoch RSI cross recency, volume trend, and candle patterns with their position context.
        Use this as your starting framework. It answers "what is price doing RIGHT NOW."
        Key things the summary gives you that indicators alone don't:
        - RSI at 30 and RISING is very different from RSI at 30 and FALLING
        - A fresh Stoch RSI bullish cross (2 candles ago) is a signal. A stale one (8 candles ago) is history.
        - MACD histogram expanding bearish = momentum accelerating down. Contracting = momentum fading, reversal may be forming.
        - Volume increasing on a move = conviction. Decreasing = fading, the move may not hold.
        - "Hammer at support ($65,730)" is a trade trigger. "Hammer in space" is noise.

        CANDLE VERIFICATION:
        Recent candles (5 per timeframe) are included. Before finalizing any entry:
        - Is your proposed entry within the recent candle range?
        - If price shows no momentum toward the entry level, the entry is unrealistic — revise or wait.
        - If the current candle is forming near a key level with a pattern, that's a stronger signal than a completed pattern several candles ago.

        THINGS YOU KNOW:
        - Volume precedes price. A move without volume is a lie.
        - Divergence is early — it's a warning, not an entry. Wait for price to confirm.
        - The first test of a level is the strongest. Each retest weakens it.
        - When everyone sees the same level, the market hunts stops just beyond it.
        - The best trades feel uncomfortable. If obvious, you're probably late.
        - ATR tells you what the market CAN do. Use it for realistic targets and stops.
        - Stop losses at structural levels, not arbitrary distances.
        - Never present a trade that contradicts your own regime or positioning read. If you said "bearish regime," do not then offer a long setup.
        - "Works if / Kills it" is not a license to counter your own analysis. If the kill condition is already true, there is no setup.
        - Market Structure: HH/HL = bullish until broken. LL/LH = bearish until broken. Structure change on the higher TF overrides lower TF structure. Fresh levels (1× test) are highest probability reactions. Worn levels (4×+) are likely to break on next test — each test absorbs resting orders.
        - Volume Profile: POC is fair value — price reverts to it in ranges. VAH/VAL act as S/R. Break above VAH with volume = acceptance higher. Break below VAL with volume = acceptance lower. In ranging regimes, fade moves to VAH/VAL back toward POC.
        - Overbought/oversold is a condition, not a signal. RSI 80 in an uptrend is strength, not a short trigger. RSI 20 in a downtrend is weakness, not a buy. Only treat OB/OS as actionable when it coincides with a level + divergence or a regime change.

        OUTPUT FORMAT (follow this structure exactly):

        ## Market Regime
        One line: TRENDING / RANGING / TRANSITIONING. Why (reference ADX, MAs, price action summary).

        ## Key Levels
        Bullet list of the 3-5 most important levels (S/R, fib, EMA) with prices. Mark which ones price is near.

        ## Bias
        One line. LONG, SHORT, or FLAT. Why. This must match your Step 3 declaration.

        ## Trade Setup
        Only if bias is LONG or SHORT with MODERATE+ conviction. Present as a markdown table:
        | Level | Price | Why | R:R |
        |-------|-------|-----|-----|
        | Entry | $X | reason | - |
        | Stop Loss | $X | reason | - |
        | TP1 | $X | reason | 1:X |
        | TP2 | $X | reason | 1:X |
        | TP3 | $X | reason | 1:X |

        Conviction: HIGH / MODERATE
        One line: what makes it work. One line: what kills it.
        If bias is FLAT, conviction is LOW, or regime contradicts direction:
        "NO SETUP — [specific reason]." Skip the table entirely. No conditional or hypothetical entries.

        ## Risk Factors
        Bullet list: upcoming events, macro headwinds/tailwinds, key invalidation levels.

        ---
        At the very end, include a JSON block with trade setups:
        ```json
        [{"direction": "LONG", "entry": 65000.0, "stopLoss": 63500.0, "tp1": 67000.0, "tp2": 69000.0, "tp3": 72000.0, "reasoning": "Brief reason"}]
        ```
        If no valid setup, output empty array: `[]`
        Use actual prices from the data. This JSON is machine-parsed to create alerts.

        IMPORTANT RULES:
        - ONLY reference indicator values, levels, and data points explicitly present in this payload. If a data field is not provided, state "data unavailable" — never estimate or infer missing values.
        - Keep it concise. No filler, no restating indicator values the user can already see.
        - Use ## headers exactly as shown above. The app parses these for section rendering.
        - Tables must use markdown pipe syntax with header row.
        - Do NOT list every indicator value — synthesize them into a narrative.
        - Maximum 400 words before the JSON block (headers, level lists, and table rows count toward this limit).

        ECONOMIC CALENDAR: If upcoming high-impact events (FOMC, CPI, NFP) are within 48 hours, flag them in Risk Factors. These can invalidate any technical setup.
        """

        if market == .crypto {
            return base + """

            \(cryptoContext)
            \(derivativesGuidance)
            """
        } else {
            return base + """

            MACRO CONTEXT (if provided — from Federal Reserve FRED data):
            - MACRO REGIME: Risk-On / Normal / Cautious / Elevated Fear / Crisis. This is the single most important macro signal.
            - VIX (EOD): End-of-day closing value from FRED. >35 = crisis (no new longs). 25-35 = elevated fear (reduce size). <15 = complacent (watch for pullback).
            - 10Y YIELD: Rising = growth stocks pressured, value/financials benefit. Falling = growth stocks benefit.
            - 2Y/10Y SPREAD: Negative (inverted) = recession signal. Positive steepening = risk-on.
            - FED FUNDS: Higher = restrictive (bearish growth). Lower = accommodative (bullish).
            - USD INDEX: Dollar up = headwind for equities/commodities. Dollar down = tailwind.
            - Factor macro regime into conviction. A bullish technical setup in "Elevated Fear" or "Crisis" regime deserves much lower conviction.

            STOCK CONTEXT:
            - Market hours 9:30 AM - 4 PM ET. Prices may be 15-min delayed.
            - Overnight gaps are normal — factor into S/R analysis.
            - Volume U-shaped intraday: high at open/close is normal, high midday is significant.
            - If fundamentals provided (P/E, earnings proximity), factor them in.
            - Timeframes: \(tf.trend) (trend), \(tf.bias) (bias), \(tf.entry) (entry).

            STOCK SENTIMENT DATA (if provided):
            - VIX (Intraday): Real-time from Yahoo Finance. >30 = extreme fear (historically bullish). <15 = complacency (watch for pullback). Prefer this over VIX EOD during market hours.
            - SHORT INTEREST: High short % of float (>10%) = crowded shorts, squeeze potential. Days to cover > 5 = shorts trapped.
            - PUT/CALL RATIO: High (>1.0) = bearish sentiment, contrarian buy. Low (<0.7) = complacent.
            - 52-WEEK POSITION: Context for S/R and trend health.
            - EARNINGS: Within 2 weeks = flag it. Setups can be invalidated by earnings regardless of technicals.
            These update daily/biweekly, not real-time. Factor in staleness.

            ENHANCED FUNDAMENTALS (if provided):
            - ANALYST TARGETS: Price below target = institutional upside expected. Near/above = limited upside, need catalyst.
            - EARNINGS HISTORY: Consecutive beats raise the bar. Approaching earnings within 2 weeks = flag risk.
            - GROWTH: Accelerating revenue + pullback = high conviction dip buy. Declining growth + breakdown = confirms weakness.
            - SECTOR: Outperforming sector = relative strength, dips get bought. Underperforming = something wrong, rallies get sold.
            - INSIDER BUYING: Cluster buying is the strongest fundamental buy signal. Weight heavily if at technical support.
            - EX-DIVIDEND: If within 5 trading days, flag it. Stock gaps down by dividend amount on ex-date — don't mistake for breakdown.
            - ESTIMATE REVISIONS: Analysts revising up over 90 days = improving outlook. Revising down = deteriorating. Revision momentum leads price.
            Fundamentals don't override technicals — they add conviction or caution.
            """
        }
    }

    private static let cryptoContext = """
    CRYPTO CONTEXT:
    - Trading 24/7, no market hours.
    - Timeframes: Daily (trend), 4H (directional bias), 1H (entry).
    - 4H sets direction, 1H sets entry. No 1H entry opposing 4H bias unless counter-trend criteria met.
    """

    private static let derivativesGuidance = """
    DERIVATIVES POSITIONING (if provided):
    - FUNDING RATE: Positive = longs pay shorts (crowded long). Negative = shorts pay longs. Extremes (>0.1% or <-0.1%) precede reversals.
    - OPEN INTEREST + PRICE: OI up + price up = real buying. OI up + price down = shorts piling in. OI down + price up = short covering (hollow rally). OI down + price down = capitulation.
    - LONG/SHORT RATIO: >60% on one side = market tends to punish them. Contrarian indicator.
    - TOP TRADERS vs RETAIL: When smart money diverges from retail, follow smart money.
    - TAKER FLOW: Aggressive market orders confirm real demand vs position covering.
    - SQUEEZE: Crowded side + extreme funding + building OI = liquidation cascade incoming. Highest R:R trades.

    An oversold RSI with crowded shorts and negative funding = high conviction long (squeeze setup).
    An oversold RSI with longs still capitulating and OI unwinding = don't catch the knife.
    Same indicator, completely different trade. Positioning is what separates them.

    SPOT PRESSURE (if provided):
    - TAKER BUY RATIO: >0.55 = aggressive buying (crossing the spread to buy). <0.45 = aggressive selling. Who is paying the spread tells you who is urgent.
    - CVD (Cumulative Volume Delta): Running buy minus sell delta. Rising CVD + falling price = accumulation. Falling CVD + rising price = distribution (hollow rally). CVD divergence from price is a high-conviction signal.
    - ORDER BOOK: Confirmation only — can be spoofed. Heavy asks + aggressive selling + falling CVD = triple confirmation of selling pressure.
    - Combined with derivatives: crowded longs + aggressive spot selling + falling CVD = trap confirmed. No setup. Exchange outflows + shorts crowding + negative funding + rising CVD = squeeze setup.
    - Spot flows confirm or deny derivatives signals. Derivatives show what traders are betting. Spot pressure shows what is actually being bought and sold. When they disagree, follow the spot pressure.
    """

    // Keep backward-compatible static
    static let systemPrompt = systemPrompt(market: .crypto)

    static func buildUserPrompt(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String,
                                stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil,
                                positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil,
                                economicEvents: [EconomicEvent] = [], macro: MacroSnapshot? = nil,
                                weeklyContext: String? = nil, spyContext: String? = nil,
                                spotPressure: SpotPressure? = nil) -> String {
        var lines = ["Symbol: \(symbol)"]

        if let s = sentiment {
            var sentParts = [String]()
            if let v = s.priceChangePercentage24h { sentParts.append("24h: \(Formatters.formatPercent(v))") }
            if let v = s.priceChangePercentage7d { sentParts.append("7d: \(Formatters.formatPercent(v))") }
            if let v = s.priceChangePercentage30d { sentParts.append("30d: \(Formatters.formatPercent(v))") }
            sentParts.append("ATH distance: \(Formatters.formatPercent(s.athChangePercentage))")
            lines.append("Sentiment: \(sentParts.joined(separator: ", "))")
        }

        if let si = stockInfo {
            var parts = [String]()
            if let pe = si.peRatio { parts.append("P/E: \(String(format: "%.1f", pe))") }
            if let eps = si.eps { parts.append("EPS: $\(String(format: "%.2f", eps))") }
            if let div = si.dividendYield { parts.append("Div Yield: \(String(format: "%.2f%%", div))") }
            parts.append("52w: \(Formatters.formatPrice(si.fiftyTwoWeekLow)) – \(Formatters.formatPrice(si.fiftyTwoWeekHigh))")
            if let sector = si.sector { parts.append("Sector: \(sector)") }
            parts.append("Market: \(si.marketState)")
            if let ed = si.earningsDate {
                let days = Calendar.current.dateComponents([.day], from: Date(), to: ed).day ?? 0
                if days > 0 { parts.append("Earnings in \(days)d") }
            }
            lines.append("Fundamentals: \(parts.joined(separator: " | "))")

            // Analyst targets
            if let target = si.analystTargetMean, let count = si.analystCount {
                let currentPrice = indicators.first?.price ?? 0
                let pctFromTarget = currentPrice > 0 ? ((target - currentPrice) / currentPrice) * 100 : 0
                var analystLine = "Analysts: \(count) covering, Mean Target \(Formatters.formatPrice(target)) (\(Formatters.formatPercent(pctFromTarget)))"
                if let rating = si.analystRating { analystLine += ", Rating: \(rating)" }
                lines.append(analystLine)
            }
            // Earnings history
            if let beats = si.consecutiveBeats {
                var earningsLine = "Earnings: Beat \(beats)/4 quarters"
                if let avg = si.avgEarningsSurprise { earningsLine += ", Avg Surprise \(Formatters.formatPercent(avg))" }
                lines.append(earningsLine)
            }
            // Growth
            if let revGrowth = si.revenueGrowthYoY {
                var growthLine = "Growth: Revenue \(Formatters.formatPercent(revGrowth)) YoY"
                if let trend = si.growthTrend { growthLine += " (\(trend))" }
                if let epsGrowth = si.earningsGrowthYoY { growthLine += " | EPS \(Formatters.formatPercent(epsGrowth)) YoY" }
                lines.append(growthLine)
            }
            // Insider activity
            if let buys = si.insiderBuyCount6m, let sells = si.insiderSellCount6m {
                lines.append("Insiders (6mo): \(buys) buys / \(sells) sells — \(si.insiderNetBuying == true ? "Net buying" : "Net selling")")
            }
            // Estimate revisions
            if let current = si.epsEstimateCurrent, let ago = si.epsEstimate90dAgo, ago != 0 {
                let changePct = ((current - ago) / abs(ago)) * 100
                var revLine = "Estimate Revisions (90d): EPS est \(Formatters.formatPrice(ago)) → \(Formatters.formatPrice(current)) (\(Formatters.formatPercent(changePct)))"
                if let dir = si.revisionDirection { revLine += " \(dir)" }
                if let up = si.upRevisions30d, let down = si.downRevisions30d {
                    revLine += " | 30d: \(up) up, \(down) down"
                }
                lines.append(revLine)
            }
            // Ex-dividend
            if let exDate = si.exDividendDate, exDate > Date() {
                let days = Calendar.current.dateComponents([.day], from: Date(), to: exDate).day ?? 0
                var divLine = "Ex-Dividend: \(exDate.formatted(date: .abbreviated, time: .omitted)) (\(days)d)"
                if let rate = si.dividendRate { divLine += " $\(String(format: "%.2f", rate))/yr" }
                if si.exDividendWarning == true { divLine += " ⚠️ WITHIN 5 DAYS" }
                lines.append(divLine)
            }
            // Sector comparison
            if let etf = si.sectorETF, let rs = si.relativeStrength1d {
                lines.append("Sector: \(si.sector ?? "N/A") (\(etf)) — \(si.outperformingSector == true ? "Outperforming" : "Underperforming") by \(Formatters.formatPercent(abs(rs)))")
            }
            // Finnhub analyst consensus
            if let buy = si.finnhubBuy, let hold = si.finnhubHold, let sell = si.finnhubSell {
                let total = buy + hold + sell
                if total > 0 {
                    lines.append("Analyst Consensus: \(buy) Buy, \(hold) Hold, \(sell) Sell (\(total) analysts)")
                }
            }
            if let beta = si.beta {
                lines.append("Beta: \(String(format: "%.2f", beta))\(beta > 1.5 ? " — HIGH volatility" : (beta < 0.5 ? " — LOW volatility" : ""))")
            }
            // Recent news headlines
            if let news = si.newsHeadlines, !news.isEmpty {
                lines.append("Recent News: \(news.prefix(3).joined(separator: " | "))")
            }
        }

        // Stock sentiment (stocks only)
        if let ss = stockSentiment {
            lines.append("")
            lines.append("=== STOCK SENTIMENT ===")
            if let vix = ss.vix {
                lines.append("VIX (intraday): \(String(format: "%.1f", vix)) (\(ss.vixLevel))\(ss.vixChange.map { String(format: " %+.1f%%", $0) } ?? "")")
            }
            if let shortPct = ss.shortPercentOfFloat {
                var shortLine = "Short Interest: \(String(format: "%.1f%%", shortPct)) of float"
                if let daysToC = ss.shortRatio { shortLine += ", Days to Cover: \(String(format: "%.1f", daysToC))" }
                if shortPct > 20 { shortLine += " — HEAVILY SHORTED, squeeze candidate" }
                else if shortPct > 10 { shortLine += " — elevated" }
                lines.append(shortLine)
            }
            lines.append("52-Week Position: \(String(format: "%.0f%%", ss.fiftyTwoWeekPosition)) (0%=52w low, 100%=52w high)")
            if let pcr = ss.putCallRatio {
                lines.append("Put/Call Ratio: \(String(format: "%.2f", pcr))\(pcr > 1.0 ? " — bearish sentiment" : (pcr < 0.7 ? " — complacent" : ""))")
            }
        }

        // Macro context (DXY, Treasury yields)
        if let m = macro {
            lines.append("")
            lines.append("=== MACRO CONTEXT ===")
            if let regime = m.macroRegime {
                lines.append("Macro Regime: \(regime)")
            }
            if let vix = m.vix {
                let level = vix > 35 ? "EXTREME FEAR" : (vix > 25 ? "ELEVATED" : (vix < 15 ? "LOW/COMPLACENT" : "NORMAL"))
                lines.append("VIX (EOD): \(String(format: "%.1f", vix)) — \(level)")
            }
            if let t10 = m.treasury10Y {
                lines.append("10Y Treasury Yield: \(String(format: "%.2f%%", t10))")
            }
            if let t2 = m.treasury2Y {
                lines.append("2Y Treasury Yield: \(String(format: "%.2f%%", t2))")
            }
            if let spread = m.yieldSpread {
                let status = spread < 0 ? "INVERTED — recession signal" : (spread < 0.5 ? "Flat — caution" : "Normal")
                lines.append("2Y/10Y Spread: \(String(format: "%.2f%%", spread)) (\(status))")
            }
            if let fed = m.fedFundsRate {
                lines.append("Fed Funds Rate: \(String(format: "%.2f%%", fed))")
            }
            if let usd = m.usdIndex {
                lines.append("USD Index: \(String(format: "%.2f", usd))")
            }
        }

        // Derivatives positioning (crypto only)
        #if DEBUG
        print("[MarketScope] [\(symbol)] Prompt: derivatives=\(derivatives != nil), positioning=\(positioning != nil), events=\(economicEvents.count), macro=\(macro != nil)")
        #endif
        if let d = derivatives, let p = positioning {
            lines.append("")
            lines.append("=== DERIVATIVES POSITIONING ===")
            let frDelta = d.fundingRatePercent - (d.avgFundingRate * 100)
            let frTrend = frDelta > 0.002 ? "rising" : (frDelta < -0.002 ? "falling" : "stable")
            lines.append("Funding Rate: \(String(format: "%.4f%%", d.fundingRatePercent)) (avg last 10: \(String(format: "%.4f%%", d.avgFundingRate * 100)), \(frTrend)) — \(p.fundingSentiment)")
            lines.append("Open Interest: \(Formatters.formatVolume(d.openInterestUSD))\(d.oiChange4h.map { String(format: " (4h: %+.1f%%)", $0) } ?? "")\(d.oiChange24h.map { String(format: " (24h: %+.1f%%)", $0) } ?? "") — \(p.oiTrend.rawValue)")
            if d.globalLongPercent != 50 || d.globalShortPercent != 50 {
                lines.append("Global L/S: Long \(Int(d.globalLongPercent))% / Short \(Int(d.globalShortPercent))% — \(p.crowding.rawValue)")
            } else {
                lines.append("Global L/S: Data unavailable (fallback source)")
            }
            if d.topTraderLongPercent != 50 || d.topTraderShortPercent != 50 {
                lines.append("Top Traders: Long \(Int(d.topTraderLongPercent))% / Short \(Int(d.topTraderShortPercent))% — \(p.smartMoneyBias)")
            } else {
                lines.append("Top Traders: Data unavailable (fallback source)")
            }
            if d.takerBuySellRatio != 1.0 || d.takerBuyVolume > 0 {
                lines.append("Taker Buy/Sell: \(String(format: "%.2f", d.takerBuySellRatio)) — \(p.takerPressure)")
            }
            if p.squeezeRisk.level != "NONE" {
                lines.append("Squeeze Risk: \(p.squeezeRisk.level) \(p.squeezeRisk.direction)")
            }
            if !p.signals.isEmpty {
                lines.append("Signals:")
                for sig in p.signals {
                    lines.append("- [\(sig.strength)] \(sig.message)")
                }
            }
            #if DEBUG
            print("[MarketScope] Prompt: Funding=\(d.fundingRatePercent), OI=$\(d.openInterestUSD), L/S=\(d.globalLongPercent)/\(d.globalShortPercent)")
            #endif
        } else {
            #if DEBUG
            print("[MarketScope] [\(symbol)] Prompt: NO derivatives (expected for stocks)")
            #endif
        }

        // Spot pressure (crypto only)
        if let sp = spotPressure {
            lines.append("")
            lines.append("=== SPOT PRESSURE ===")
            lines.append("Taker Buy Ratio (24h): \(String(format: "%.2f", sp.takerBuyRatio)) (\(sp.takerBuyLabel))")
            lines.append("CVD 24h: \(String(format: "%.1f", sp.cvd24h)) (\(sp.cvdTrend))")
            if let bookRatio = sp.bookRatio, let bookLabel = sp.bookLabel {
                lines.append("Order Book: \(String(format: "%.2f", bookRatio)) (\(bookLabel))")
            }
        }

        #if DEBUG
        print("[MarketScope] [\(symbol)] \(economicEvents.count) economic events")
        #endif
        if !economicEvents.isEmpty {
            lines.append("")
            lines.append("=== UPCOMING ECONOMIC EVENTS ===")
            for event in economicEvents {
                var line = "\(event.title) (\(event.country)) — \(event.date.formatted(date: .abbreviated, time: .shortened))"
                if let forecast = event.forecast, !forecast.isEmpty { line += " | Exp: \(forecast)" }
                if event.isWithin48Hours { line += " ⚠️ WITHIN 48H" }
                lines.append(line)
            }
        }

        // Market structure + volatility regime + momentum alignment
        if let daily = indicators.first, daily.candles.count >= 15 {
            if let structure = MarketStructure.analyze(candles: daily.candles, atr: daily.atr?.atr ?? 0) {
                lines.append("")
                lines.append("=== MARKET STRUCTURE ===")
                lines.append("Structure: \(structure.label)")
                if !structure.swingHighs.isEmpty {
                    lines.append("Swing Highs: \(structure.swingHighs.map { Formatters.formatPrice($0) }.joined(separator: " > "))")
                }
                if !structure.swingLows.isEmpty {
                    lines.append("Swing Lows: \(structure.swingLows.map { Formatters.formatPrice($0) }.joined(separator: " > "))")
                }
                for level in structure.levelTests.prefix(3) {
                    let freshness = level.candlesAgo <= 3 ? "fresh" : (level.candlesAgo <= 10 ? "recent" : "old")
                    lines.append("\(Formatters.formatPrice(level.price)) (tested \(level.tests)×, \(freshness) — \(level.candlesAgo) candles ago)")
                }
            }

            if let volRegime = VolatilityRegime.atrPercentile(candles: daily.candles) {
                lines.append("ATR Percentile: \(Int(volRegime.percentile))% (\(volRegime.label))")
            }
        }

        // Momentum alignment across timeframes
        let alignment = MomentumAlignment.compute(indicators: indicators)
        lines.append("Momentum Alignment: \(alignment.score > 0 ? "+" : "")\(alignment.score)/9 (\(alignment.label))")

        // Price Action Summary (computed from candle data)
        let summaries = indicators.map { PriceActionAnalyzer.analyze(indicator: $0) }
        let hasSummary = summaries.contains { !$0.summaryText.isEmpty && $0.regime.regime != "insufficient_data" }
        if hasSummary {
            lines.append("")
            lines.append("=== PRICE ACTION SUMMARY ===")
            for summary in summaries {
                if summary.regime.regime != "insufficient_data" {
                    lines.append(summary.summaryText)
                    lines.append("")
                }
            }
        }

        // Weekly context (real weekly candles if available, else derived from daily)
        if let wc = weeklyContext {
            lines.append("")
            lines.append("=== WEEKLY CONTEXT ===")
            lines.append(wc)
        } else if let daily = indicators.first, daily.candles.count >= 5 {
            let weekCandles = Array(daily.candles.suffix(5))
            let weekOpen = weekCandles.first?.open ?? 0
            let weekClose = weekCandles.last?.close ?? 0
            let weekHigh = weekCandles.map(\.high).max() ?? 0
            let weekLow = weekCandles.map(\.low).min() ?? 0
            let weekChange = weekOpen > 0 ? ((weekClose - weekOpen) / weekOpen) * 100 : 0
            let weekTrend = weekChange > 1 ? "Bullish" : (weekChange < -1 ? "Bearish" : "Neutral")
            lines.append("")
            lines.append("=== WEEKLY CONTEXT (estimated from daily) ===")
            lines.append("Trend: \(weekTrend) (\(String(format: "%+.1f%%", weekChange))), Range: \(Formatters.formatPrice(weekLow)) – \(Formatters.formatPrice(weekHigh))")
        }

        // SPY market proxy
        if let spy = spyContext {
            lines.append("")
            lines.append("=== BROAD MARKET (SPY) ===")
            lines.append(spy)
        }

        lines.append("")

        for ind in indicators {
            lines.append("=== \(ind.label) ===")
            lines.append("Price: \(Formatters.formatPrice(ind.price)) | Bias: \(ind.bias) (\(Int(ind.bullPercent))% bullish)")

            if let rsi = ind.rsi {
                var rsiStr = "RSI: \(rsi)"
                if let sr = ind.stochRSI {
                    rsiStr += " | Stoch RSI: \(sr.k)/\(sr.d)"
                    if let cross = sr.crossover { rsiStr += " (\(cross) crossover)" }
                    else { rsiStr += " (no crossover)" }
                }
                lines.append(rsiStr)
            }
            if let macd = ind.macd {
                let crossLabel = macd.crossover.map { " Crossover: \($0)" } ?? " (no crossover)"
                lines.append("MACD: \(macd.macd) Signal: \(macd.signal) Hist: \(macd.histogram)\(crossLabel)")
            }
            if let adx = ind.adx {
                if adx.adx < 20 {
                    lines.append("ADX: \(adx.adx) (No Trend — direction unreliable) +DI: \(adx.plusDI) -DI: \(adx.minusDI)")
                } else {
                    lines.append("ADX: \(adx.adx) (\(adx.strength), \(adx.direction)) +DI: \(adx.plusDI) -DI: \(adx.minusDI)")
                }
            }
            if let bb = ind.bollingerBands {
                lines.append("BB: Upper=\(Formatters.formatPrice(bb.upper)) Mid=\(Formatters.formatPrice(bb.middle)) Lower=\(Formatters.formatPrice(bb.lower)) | %B \(bb.percentB), BW \(bb.bandwidth)%\(bb.squeeze ? " SQUEEZE" : " (no squeeze)")")
            }
            if let atr = ind.atr {
                lines.append("ATR: \(Formatters.formatPrice(atr.atr)) (\(atr.atrPercent)%)")
            }

            var maParts = [String]()
            if let e20 = ind.ema20 { maParts.append("EMA20=\(Formatters.formatPrice(e20))") }
            if let e50 = ind.ema50 { maParts.append("EMA50=\(Formatters.formatPrice(e50))") }
            if let e200 = ind.ema200 { maParts.append("EMA200=\(Formatters.formatPrice(e200))") }
            if let s50 = ind.sma50 { maParts.append("SMA50=\(Formatters.formatPrice(s50))") }
            if let s200 = ind.sma200 { maParts.append("SMA200=\(Formatters.formatPrice(s200))") }
            if !maParts.isEmpty { lines.append("MAs: \(maParts.joined(separator: " "))") }

            if let e20 = ind.ema20, let e50 = ind.ema50, let e200 = ind.ema200 {
                if e20 > e50 && e50 > e200 { lines.append("Structure: Bullish (EMA 20 > 50 > 200)") }
                else if e20 < e50 && e50 < e200 { lines.append("Structure: Bearish (EMA 20 < 50 < 200)") }
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
            if let vp = ind.volumeProfile {
                let vaWidth = vp.poc > 0 ? ((vp.valueAreaHigh - vp.valueAreaLow) / vp.poc) * 100 : 0
                lines.append("Volume Profile: POC \(Formatters.formatPrice(vp.poc)) | VAH \(Formatters.formatPrice(vp.valueAreaHigh)) | VAL \(Formatters.formatPrice(vp.valueAreaLow)) (\(String(format: "%.1f%%", vaWidth)) VA width)")
            }

            if let div = ind.divergence { lines.append("Divergence: \(div)") }
            if !ind.candlePatterns.isEmpty {
                lines.append("Patterns: \(ind.candlePatterns.map(\.pattern).joined(separator: ", "))")
            }

            // Stock-only indicators
            if let obv = ind.obv {
                lines.append("OBV: \(obv.trend)\(obv.divergence.map { " — \($0)" } ?? "")")
            }
            if let ad = ind.adLine { lines.append("A/D Line: \(ad.trend)") }
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

        // POC alignment (Daily vs 4H) + Naked POC
        if indicators.count >= 2 {
            let dailyVP = indicators[0].volumeProfile
            let fourHVP = indicators[1].volumeProfile
            let atrVal = indicators[0].atr?.atr ?? 0
            if let alignment = VolumeProfile.pocAlignment(daily: dailyVP, fourH: fourHVP, atr: atrVal) {
                lines.append("POC Alignment: \(alignment)")
            }
            // Store today's daily POC for naked POC tracking
            if let dpoc = dailyVP?.poc {
                VolumeProfile.storePOC(dpoc, symbol: symbol)
            }
            // Check for naked POC from previous session
            if let last = indicators[0].candles.last {
                if let naked = VolumeProfile.nakedPOC(symbol: symbol, currentLow: last.low, currentHigh: last.high) {
                    lines.append("Naked POC: \(Formatters.formatPrice(naked.price)) (untested from \(naked.date))")
                }
            }
        }

        // Recent candles (5 closed + 1 forming per timeframe)
        let hasCandles = indicators.contains { !$0.candles.isEmpty }
        if hasCandles {
            lines.append("=== RECENT CANDLES ===")
            for ind in indicators {
                let recent = Array(ind.candles.suffix(6))
                guard !recent.isEmpty else { continue }
                lines.append("\(ind.label) (last \(recent.count), newest first, format: [O, H, L, C, Vol]):")
                for (i, c) in recent.reversed().enumerated() {
                    let forming = i == 0 ? " (forming)" : ""
                    lines.append("\(i + 1). [\(fmt(c.open)), \(fmt(c.high)), \(fmt(c.low)), \(fmt(c.close)), \(String(format: "%.0f", c.volume))]\(forming)")
                }
                lines.append("")
            }
        }

        let prompt = lines.joined(separator: "\n")
        #if DEBUG
        print("[MarketScope] [\(symbol)] Prompt built: \(prompt.count) chars, \(lines.count) lines")
        let sections = prompt.components(separatedBy: "===").count - 1
        print("[MarketScope] [\(symbol)] Sections: \(sections)")
        #endif
        return prompt
    }

    private static func fmt(_ price: Double) -> String {
        Formatters.formatPrice(price)
    }

    /// Extract trade setups from the ```json block in the response.
    static func parseSetups(from text: String) -> [TradeSetup] {
        // Try ```json\n...\n```
        if let jsonStart = text.range(of: "```json\n"),
           let jsonEnd = text.range(of: "\n```", range: jsonStart.upperBound..<text.endIndex) {
            let json = String(text[jsonStart.upperBound..<jsonEnd.lowerBound])
            let setups = decodeSetups(json)
            #if DEBUG
            print("[MarketScope] Parsed \(setups.count) setups from JSON block (\(json.count) chars)")
            #endif
            return setups
        }
        // Try ```json...``` without newlines
        if let js = text.range(of: "```json"),
           let je = text.range(of: "```", range: js.upperBound..<text.endIndex) {
            let json = String(text[js.upperBound..<je.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            let setups = decodeSetups(json)
            #if DEBUG
            print("[MarketScope] Parsed \(setups.count) setups from inline JSON (\(json.count) chars)")
            #endif
            return setups
        }
        #if DEBUG
        print("[MarketScope] No JSON block found in response")
        #endif
        return []
    }

    private static func decodeSetups(_ jsonString: String) -> [TradeSetup] {
        guard let data = jsonString.data(using: .utf8) else { return [] }
        do {
            return try JSONDecoder().decode([TradeSetup].self, from: data)
        } catch {
            #if DEBUG
            print("[MarketScope] Setup parse failed: \(error)")
            #endif
            return []
        }
    }
}
