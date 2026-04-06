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
        The regime label is pre-computed in the PRE-COMPUTED FLAGS section and is AUTHORITATIVE. Use it as-is. The regime_details (ADX, MA alignment, BB squeeze) are provided for your narrative only — do not reclassify the regime.
        If regime_changed is false, output only: "## Market Regime\n[REGIME] (unchanged)" — do not re-explain. Save token budget for setup and watching sections.
        Only state "regime changed" if the Regime Changed field is explicitly true in the PRE-COMPUTED FLAGS. If the field is not present, do not infer regime change status — treat as unchanged.
        - TRENDING: ADX > 25, price respecting EMAs, MAs stacked in order
        - RANGING: ADX < 20, price oscillating between S/R, MAs flat/tangled
        - TRANSITIONING: breaking out of range or trend exhausting
        This determines your playbook.

        STEP 2: APPLY THE RIGHT PLAYBOOK
        TRENDING: Trade WITH the trend. Entries on pullbacks to EMAs or fib retracements. Oversold RSI in a strong trend is a buying opportunity. Stop below recent higher low (longs) or above recent lower high (shorts).
        RANGING: Fade the extremes. Buy support, sell resistance. RSI and Stoch RSI OB/OS work here. Stops just outside the range.
        TRANSITIONING: Biggest moves start here. Bollinger squeeze + volume = highest conviction. First pullback after breakout is bread-and-butter. Failed breakdowns are powerful reversals. Wait for the retest — the retest IS the trade.

        STEP 3: DECLARE YOUR BIAS (Hierarchical Resolution)

        LABEL AUTHORITY: The per-timeframe bias labels (Bearish/Bullish/Neutral) in the data header are pre-computed by the app and are AUTHORITATIVE. Use them as-is for bias resolution below. Do NOT override these labels with your own interpretation of the raw indicator data. The raw indicators are for confluence analysis in Step 4 and Risk Factors — not for re-litigating bias labels. The ONLY exception: if a label is "Neutral" and raw data shows a clear directional breakout within the most recent 2 candles, you may upgrade Neutral to the breakout direction. You may NEVER downgrade or flip a Bearish/Bullish label.

        Daily sets directional authority. 4H confirms or negates. 1H determines entry timing only.
        Read the pre-computed bias labels for Daily and 4H. Apply these rules IN ORDER — stop at the first match:

        Rule 1 — DAILY + 4H LABELS ALIGNED (both Bearish, or both Bullish):
           → Bias = that direction, regardless of 1H.
           → If 1H opposes: classify as COUNTER-TREND PULLBACK (entry opportunity, not conflict).
           → Proceed to Step 4 for trade setup.
           → Output: "Bias: [DIRECTION] (Rule 1 — D+4H aligned [direction], 1H [state] classified as counter-trend pullback)"

        Rule 2 — DAILY + 4H LABELS CONFLICT (one Bearish, one Bullish):
           → Bias = FLAT. Skip Step 4. No trade.
           → Output: "Bias: FLAT (Rule 2 — D [label] conflicts with 4H [label])"

        Rule 3 — DAILY OR 4H LABEL IS NEUTRAL:
           → If one is directional and the other is Neutral: Bias = the directional label. Use 1H for timing.
           → If both are Neutral: Bias = FLAT.
           → Output: "Bias: [DIRECTION] (Rule 3 — D [label], 4H [label], deferring to [whichever is directional])"

        ANTI-GAMING RULES:
        - You may NOT selectively cite raw 4H indicators (ascending lows, improving MACD, rising RSI) to argue a pre-computed label is "wrong" and then use your reinterpretation to trigger a different rule.
        - If the 4H label says Bearish, treat it as Bearish for Step 3 — even if you see bullish signals in the raw 4H data. Note those observations in Risk Factors as monitoring items, not as grounds to change bias.
        - 4H printing higher lows while Daily remains in LH/LL = corrective retracement, NOT structural conflict — unless 4H breaks above the most recent Daily lower high.
        - 4H printing lower highs while Daily remains in HH/HL = corrective pullback, NOT structural conflict — unless 4H breaks below the most recent Daily higher low.
        - 1H NEVER determines or vetoes bias. A 1H move opposing Daily+4H is expected market behavior, not a reason to go FLAT.
        - FLAT is a label-level determination only. If D+4H labels agree, there IS a direction — trade it or explain in Step 4 why setup quality is insufficient.

        If FLAT — skip Step 4 entirely. Go straight to output with "NO SETUP."

        KILL CONDITION GATE (evaluate before Step 4):
        If counter_trend_pullback is true in the PRE-COMPUTED FLAGS, check kill conditions BEFORE building any setup:

        If divergence_escalated is true (6+ candles of 4H divergence against bias):
          → The counter-trend pullback premise has expired. This is no longer a temporary 1H counter-move — it is a potential trend transition.
          → Override bias to FLAT regardless of label alignment.
          → Output: "Bias: FLAT (divergence escalated — 4H divergence against D bias for 6+ candles indicates trend transition, not pullback. Watch for 4H label flip to confirm new direction.)"
          → Do not present any setup. State what resolves the situation: either 4H label flips (confirming transition) or divergence collapses and kills clear (restoring the original thesis).
          → Go directly to Risk Factors, then empty JSON [].

        If ANY_KILLED is true (but divergence not escalated):
          → Skip Step 4 entirely. Do not construct a setup table.
          → Output format:
            ## Bias
            "Bias: [DIRECTION] (Rule 1 — D+4H aligned [direction]). Counter-trend entry BLOCKED: [kill flag names only, no explanation]. See Risk Factors for monitoring items."
            Do not explain what divergence means or why volume matters. The kill names are sufficient.
            ## Trade Setup
            "NO SETUP — Kill conditions active."
            Then output a structured watching section:
            **Prerequisites** (must clear before entry is possible):
            - [conditions that need to change — e.g., divergence clearing, volume normalizing]
            **Entry trigger** (the specific confirmation that activates the trade):
            - [the one thing that gets you in — e.g., rejection candle at $X with declining volume]
            **Re-evaluate on:** [specific time or price level, whichever comes first]
          → Go directly to Risk Factors, then empty JSON [].

        If ANY_KILLED is false:
          → Proceed to Step 4. Build the counter-trend pullback setup with the mandatory kill checklist (all will show PASS).

        STEP 4: FIND THE TRADE (only if bias is LONG or SHORT and kill gate is CLEAR)
        If you declared FLAT in Step 3, or if the kill gate blocked entry, skip this step entirely.
        The best setups have 3 things:
        1. A LEVEL — price at meaningful spot (S/R, fib, EMA, VWAP). No level = no trade.
        2. A SIGNAL — something happening at that level (candle pattern, RSI divergence, volume spike, Stoch RSI cross\(market == .crypto ? ", squeeze risk, taker flow" : "")). A level without a signal is just a number.
        3. RISK DEFINITION — you can define exactly where you're wrong. No logical stop = skip it.

        If all three exist, present the setup as a table with Entry, SL, TP1, TP2, TP3 rows showing Price, Why, and R:R.
        Rate conviction:
        - HIGH: 3+ confluences, all timeframes aligned (D + 4H + 1H same direction), no macro event within 12 hours, derivatives positioning supports direction.
        - MODERATE: 2+ confluences, D + 4H aligned with 1H counter-trend providing entry (counter-trend pullback setup), no macro event within 4 hours. OR: All timeframes aligned but only 2 confluences.
        - LOW: Fewer than 2 confluences, OR macro event within 2 hours, OR derivatives positioning strongly opposes the setup. → NO TRADE.
        - FLAT: Daily and 4H pre-computed bias labels conflict (one Bearish, one Bullish), OR both labels are Neutral. → NO TRADE.
        One line: what makes it work, what kills it.

        If two exist but one is missing, say what's missing and what to watch for.
        If no structure, say "no trade — here's what I'm watching."

        Show both directions when both have merit. Show one when only one makes sense. Show none when the market isn't giving anything. Never force it.

        COUNTER-TREND PULLBACK SETUP:
        Trigger: Bias set by Daily+4H alignment, but 1H is moving AGAINST that bias.
        This is a HIGH-PROBABILITY pattern — you are entering with the higher-timeframe trend after the lower timeframe exhausts its counter-move.

        ENTRY CONDITIONS (ALL required):
        1. Daily and 4H bias aligned in the same direction (from Step 3).
        2. 1H is in a counter-trend move (squeeze, impulse, or drift against D/4H bias).
        3. 1H counter-move reaches a significant higher-timeframe level:
           - For shorts: 1H rallies into 4H resistance, EMA cluster, prior breakdown level, or upper volume profile zone (VAH/POC).
           - For longs: 1H sells off into 4H support, EMA cluster, prior breakout level, or lower volume profile zone (VAL/POC).
        4. 1H shows exhaustion signal at that level:
           - Bearish: inverted hammer, bearish engulfing, squeeze failure, divergence on 1H RSI, volume decline on push higher, taker ratio dropping.
           - Bullish: hammer, bullish engulfing, squeeze failure to downside, 1H RSI divergence, volume decline on push lower, taker ratio rising.

        ENTRY TRIGGER:
        - Enter in the direction of Daily+4H bias AFTER the 1H exhaustion signal confirms.
        - "Confirms" = 1H candle close showing rejection (wick > body at the level), OR 1H close back below/above the level after a false breakout.

        STOP PLACEMENT:
        - Beyond the 1H counter-move extreme (the high of the rally for shorts, the low of the selloff for longs).
        - Must satisfy minimum R:R requirement.

        TARGET:
        - T1: Next 4H support/resistance level in the direction of bias.
        - T2: Prior Daily swing low (for shorts) or swing high (for longs).

        KILL CONDITIONS (do NOT enter even if pattern forms):
        - 4H shows bullish/bearish divergence AGAINST the Daily bias direction (suggests Daily trend is weakening, not just a pullback).
        - Volume on the 1H counter-move is significantly HIGHER than the prior trend-direction move (institutional participation in the counter-move).
        - Funding rate has flipped to support the counter-move direction (market structure shifting, not just a pullback).
        - High-impact macro event within 4 hours.

        MANDATORY: Output the kill condition checklist ONLY when presenting a counter-trend pullback setup (all checks will be PASS). If ANY_KILLED is true, the kill gate already blocked entry — do not repeat the checklist. Kill conditions are pre-computed in the PRE-COMPUTED FLAGS section and are authoritative. Do not re-evaluate from raw data.
        The kill condition flags are:
        - divergence_against_bias: 4H RSI/MACD showing divergence against the bias direction
        - counter_move_volume_exceeds: 1H counter-move volume > 1.2x trend volume
        - funding_supports_counter: Funding rate flipped to support the counter-move
        - macro_event_within_4h: High-impact macro event within 4 hours

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
        State which rule fired: "Bias: SHORT via Rule 1 — D+4H aligned bearish, 1H counter-trend pullback." This must match your Step 3 declaration.

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
        Maximum 3 bullets. Ranked by what is most likely to change the picture in the next 1-4 hours. Do not restate information already covered in the Bias or Trade Setup sections. Focus on:
        1. What could flip a label or clear a kill condition
        2. What external catalyst could override the technical picture
        3. Key invalidation level with specific price
        Raw data observations that diverge from pre-computed labels belong here (e.g., "4H raw data showing ascending lows — monitor for potential label flip on next refresh").

        **Next decision point:** [specific time-based event OR price level], whichever comes first.
        This must be ONE line with at most two conditions. Always include a time component (next candle close, next 4H close, specific event time) so the user knows when to look again.
        Examples: "Next decision point: 4H candle close at 6:00 PM ET or price reaching $67,663." / "Next decision point: 1H close below $66,938 or NFP release tomorrow 8:30 AM ET."

        ---
        At the very end, include a JSON block with trade setups:
        ```json
        [{"direction": "LONG", "entry": 65000.0, "stopLoss": 63500.0, "tp1": 67000.0, "tp2": 69000.0, "tp3": 72000.0, "suggestedQty": 0.33, "reasoning": "Brief reason"}]
        ```
        If no valid setup, output empty array: `[]`
        Use actual prices from the data. This JSON is machine-parsed to create alerts.

        IMPORTANT RULES:
        - ONLY reference indicator values, levels, and data points explicitly present in this payload. If a data field is not provided, state "data unavailable" — never estimate or infer missing values.
        - Keep it concise. No filler, no restating indicator values the user can already see.
        - Use ## headers exactly as shown above. The app parses these for section rendering.
        - Tables must use markdown pipe syntax with header row.
        - Do NOT list every indicator value — synthesize them into a narrative.
        - Maximum 500 words before the JSON block (headers, level lists, and table rows count toward this limit).
        - ALL times in your output must be in Eastern Time (ET). Convert any UTC timestamps to ET before displaying. Use "ET" suffix (e.g., "4:00 PM ET", "8:30 AM ET"). This applies to: Next decision point, economic event times, candle close times, and any other time references.

        ECONOMIC CALENDAR: If upcoming high-impact events (FOMC, CPI, NFP) are within 48 hours, flag them in Risk Factors. These can invalidate any technical setup.
        MACRO RISK: The macro event proximity is pre-computed as `Macro Risk` in the PRE-COMPUTED FLAGS section. If IMMINENT, conviction cannot exceed LOW (no trade). If NEARBY, conviction cannot exceed MODERATE. If UPCOMING or ON_HORIZON, flag in Risk Factors but do not suppress conviction.

        TAGGED LEVELS: Levels in the TAGGED LEVELS section are pre-computed with proximity (IN_PLAY / NEARBY / DISTANT) and ATR distance. IN_PLAY levels are the only candidates for primary entries. NEARBY levels may be used for conditional/wait entries. DISTANT levels are targets only — never propose them as entries.
        CANDIDATE SETUPS: If pre-computed candidate setups are provided, use the exact R:R values shown — do not recalculate. Select the best candidate based on signal quality, exhaustion signals, and confluence. If no candidate is marked Viable (R:R >= 1.5), there is no setup. You may adjust entry price slightly based on the current candle pattern (e.g., entry at the wick rejection rather than the level itself), but do not recalculate R:R — state that the entry is adjusted and the pre-computed R:R is approximate.
        CANDLE CLOSE TIMESTAMPS: Use the pre-computed Next 4H Close and Next Daily Close timestamps for the "Next decision point" line. Do not calculate candle close times yourself.
        KILLS CLEARING: If Kills Clearing flags are present, mention them in the Prerequisites section of the watching output. Do not analyze raw data to determine if kills are clearing — use the pre-computed flags.
        DATA QUALITY: If a DATA QUALITY section is present in the payload, some data sources failed. Mention missing data in Risk Factors. If candle data is flagged as stale, note it prominently — price levels may have shifted. Do not fabricate values for missing data sources. Reduce conviction by one level if 2+ enrichment sources are missing.
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
                                spotPressure: SpotPressure? = nil,
                                dataQuality: DataQuality? = nil,
                                crossAsset: CrossAssetContext? = nil) -> String {
        var lines = ["Symbol: \(symbol)"]

        // Data quality gate — warn about missing/stale data
        if let dq = dataQuality, let section = dq.promptSection {
            lines.append("")
            lines.append("=== DATA QUALITY ===")
            lines.append(section)
        }

        // Cross-asset context (crypto only)
        if let ca = crossAsset {
            lines.append("")
            lines.append("=== CROSS-ASSET CONTEXT ===")
            lines.append(ca.summary)
            lines.append("DXY: \(Formatters.formatPrice(ca.dxyPrice)) vs EMA20 \(Formatters.formatPrice(ca.dxyEma20)) → \(ca.dxyTrend)")
            lines.append("SPY: \(Formatters.formatPrice(ca.spyPrice)) vs EMA20 \(Formatters.formatPrice(ca.spyEma20)) → \(ca.spyTrend)")
        }

        // === PRE-COMPUTED FLAGS (Phases 1-5) ===
        if indicators.count >= 2 {
            let daily = indicators[0]
            let fourH = indicators[1]
            let oneH = indicators.count > 2 ? indicators[2] : nil

            // Phase 1 — Regime label
            let adxDaily = daily.adx?.adx ?? 0
            var maAlignment = "tangled"
            if let e20 = daily.ema20, let e50 = daily.ema50, let e200 = daily.ema200 {
                if e20 > e50 && e50 > e200 { maAlignment = "bullish_stacked" }
                else if e20 < e50 && e50 < e200 { maAlignment = "bearish_stacked" }
            }
            let bbSqueezeAny = indicators.contains { $0.bollingerBands?.squeeze == true }

            let regime: String
            if adxDaily > 25 && maAlignment != "tangled" {
                regime = "TRENDING"
            } else if bbSqueezeAny || (adxDaily >= 20 && adxDaily <= 25) {
                regime = "TRANSITIONING"
            } else if adxDaily < 20 {
                regime = "RANGING"
            } else {
                // ADX > 25 but MAs tangled = strong energy without clear trend
                regime = "TRANSITIONING"
            }

            // Phase 2 — Regime staleness
            let regimeKey = "regime_\(symbol)"
            let previousRegime = UserDefaults.standard.string(forKey: regimeKey)
            let regimeChanged = previousRegime != regime
            UserDefaults.standard.set(regime, forKey: regimeKey)

            lines.append("")
            lines.append("=== PRE-COMPUTED FLAGS (authoritative — do not reclassify) ===")
            if regimeChanged {
                lines.append("Regime: \(regime) (ADX_daily: \(String(format: "%.1f", adxDaily)), MA_alignment: \(maAlignment), BB_squeeze: \(bbSqueezeAny))")
                lines.append("Regime Changed: true")
            } else {
                lines.append("Regime: \(regime)")
                lines.append("Regime Changed: false")
            }

            // Phase 2a — Counter-trend flag + bias alignment
            let dailyBias = daily.bias
            let fourHBias = fourH.bias
            let oneHBias = oneH?.bias ?? "Neutral"

            let dailyBearish = dailyBias.contains("Bearish")
            let dailyBullish = dailyBias.contains("Bullish")
            let fourHBearish = fourHBias.contains("Bearish")
            let fourHBullish = fourHBias.contains("Bullish")

            let biasAligned = (dailyBearish && fourHBearish) || (dailyBullish && fourHBullish)
            let oneHOpposes = biasAligned && ((dailyBearish && oneHBias.contains("Bullish")) || (dailyBullish && oneHBias.contains("Bearish")))
            let alignedDirection = dailyBearish ? "SHORT" : (dailyBullish ? "LONG" : "FLAT")
            // Read kill duration state BEFORE it gets updated — needed by kills-clearing later
            let killDurKeyOuter = "killDur_\(symbol)"
            let prevDurState = (UserDefaults.standard.dictionary(forKey: killDurKeyOuter) as? [String: Int]) ?? [:]

            lines.append("Bias Alignment: Daily=\(dailyBias), 4H=\(fourHBias), 1H=\(oneHBias)")
            lines.append("Counter-Trend Pullback: \(oneHOpposes) | Aligned Direction: \(alignedDirection)")

            // Phase 2b — Kill conditions (only relevant if counter-trend)
            if oneHOpposes, let oneHData = oneH {
                var killDivergence = false
                var killVolume = false
                var killFunding = false
                var killMacro = false

                // 2b.1 — 4H MACD histogram structural divergence
                // Histogram sign alone is NOT divergence — compare trough/peak progression
                if fourH.macdHistSeries.count >= 10 {
                    let histSeries = fourH.macdHistSeries
                    if dailyBearish {
                        // Bullish divergence: histogram troughs getting shallower (less negative)
                        let troughs = findTroughs(histSeries)
                        if troughs.count >= 2 {
                            let older = troughs[troughs.count - 2]
                            let newer = troughs[troughs.count - 1]
                            if older < 0 && newer < 0 && newer > older { killDivergence = true }
                        }
                    }
                    if dailyBullish {
                        // Bearish divergence: histogram peaks getting lower
                        let peaks = findPeaks(histSeries)
                        if peaks.count >= 2 {
                            let older = peaks[peaks.count - 2]
                            let newer = peaks[peaks.count - 1]
                            if older > 0 && newer > 0 && newer < older { killDivergence = true }
                        }
                    }
                }
                // Also check 4H RSI divergence using swing point detection
                if fourH.rsiSeries.count >= 15 && fourH.candles.count >= 15 {
                    let lookbackCandles = Array(fourH.candles.suffix(20))
                    let lookbackRSI = Array(fourH.rsiSeries.suffix(min(20, fourH.rsiSeries.count)))
                    if lookbackCandles.count == lookbackRSI.count {
                        let biasDir = dailyBearish ? "Bearish" : "Bullish"
                        if DivergenceDetector.hasDivergence(candles: lookbackCandles, rsiSeries: lookbackRSI, biasDirection: biasDir) {
                            killDivergence = true
                        }
                    }
                }

                // 2b.2 — 1H counter-move volume vs trend volume (direction-aware)
                if oneHData.candles.count >= 6 {
                    let recent = Array(oneHData.candles.suffix(6))
                    let counterCandles: [Candle]
                    let trendCandles: [Candle]
                    if dailyBearish {
                        counterCandles = recent.filter { $0.close > $0.open }
                        trendCandles = recent.filter { $0.close <= $0.open }
                    } else {
                        counterCandles = recent.filter { $0.close < $0.open }
                        trendCandles = recent.filter { $0.close >= $0.open }
                    }
                    let counterAvg = counterCandles.isEmpty ? 0 : counterCandles.map(\.volume).reduce(0, +) / Double(counterCandles.count)
                    let trendAvg = trendCandles.isEmpty ? 0 : trendCandles.map(\.volume).reduce(0, +) / Double(trendCandles.count)
                    let avgVol = recent.map(\.volume).reduce(0, +) / Double(recent.count)
                    let minThreshold = avgVol * 0.3
                    if trendAvg > 0 && counterAvg > trendAvg * 1.2 && counterAvg > minThreshold {
                        killVolume = true
                    }
                }

                // 2b.3 — Funding rate flip
                if let d = derivatives {
                    let fr = d.fundingRatePercent
                    if dailyBearish && fr < -0.01 { killFunding = true }
                    if dailyBullish && fr > 0.01 { killFunding = true }
                }

                // 2b.4 — Macro event within 4h
                let macroIn4h = economicEvents.filter { $0.isHighImpact && $0.isUpcoming }.contains {
                    $0.date.timeIntervalSinceNow > 0 && $0.date.timeIntervalSinceNow < 4 * 3600
                }
                killMacro = macroIn4h

                let anyKilled = killDivergence || killVolume || killFunding || killMacro

                // Phase 3 — Kill duration tracking (candle-anchored, not refresh-anchored)
                let killDurKey = "killDur_\(symbol)"
                let killDurCandleKey = "killDurCandle_\(symbol)"
                let lastTrackedCandle = UserDefaults.standard.object(forKey: killDurCandleKey) as? Date
                let latest4HCandle = fourH.candles.last?.time
                let isNewCandle = lastTrackedCandle == nil || (latest4HCandle != nil && latest4HCandle! > lastTrackedCandle!)

                var durState = prevDurState
                if isNewCandle {
                    durState["divergence"] = killDivergence ? (durState["divergence"] ?? 0) + 1 : 0
                    durState["volume"] = killVolume ? (durState["volume"] ?? 0) + 1 : 0
                    durState["funding"] = killFunding ? (durState["funding"] ?? 0) + 1 : 0
                    UserDefaults.standard.set(durState, forKey: killDurKey)
                    if let candle = latest4HCandle {
                        UserDefaults.standard.set(candle, forKey: killDurCandleKey)
                    }
                } else {
                    // Same candle — don't increment, but clear if kill resolved mid-candle
                    if !killDivergence { durState["divergence"] = 0 }
                    if !killVolume { durState["volume"] = 0 }
                    if !killFunding { durState["funding"] = 0 }
                    UserDefaults.standard.set(durState, forKey: killDurKey)
                }

                // Divergence escalation: 6+ candles = trend transition, not pullback
                let divergenceEscalated = (durState["divergence"] ?? 0) >= 6

                var killParts = [String]()
                if killDivergence { killParts.append("divergence_against_bias(\(durState["divergence"] ?? 1) candles)") }
                if killVolume { killParts.append("counter_move_volume_exceeds(\(durState["volume"] ?? 1) candles)") }
                if killFunding { killParts.append("funding_supports_counter(\(durState["funding"] ?? 1) candles)") }
                if killMacro { killParts.append("macro_event_within_4h") }
                lines.append("Kill Conditions: \(killParts.isEmpty ? "none" : killParts.joined(separator: ", ")), ANY_KILLED=\(anyKilled)")
                lines.append("Divergence Escalated: \(divergenceEscalated)")
            }

            // Phase 5 — Macro event window
            let highImpactUpcoming = economicEvents.filter { $0.isHighImpact && $0.isUpcoming }
            if let nearest = highImpactUpcoming.first {
                let hoursUntil = nearest.date.timeIntervalSinceNow / 3600
                let macroRisk: String
                if hoursUntil <= 2 { macroRisk = "IMMINENT" }
                else if hoursUntil <= 4 { macroRisk = "NEARBY" }
                else if hoursUntil <= 12 { macroRisk = "UPCOMING" }
                else { macroRisk = "ON_HORIZON" }
                lines.append("Macro Risk: \(macroRisk) — \(nearest.title) in \(String(format: "%.1f", hoursUntil))h")
                lines.append("Conviction Cap: \(macroRisk == "IMMINENT" ? "LOW (no trade)" : macroRisk == "NEARBY" ? "MODERATE max" : "no cap")")
            } else {
                lines.append("Macro Risk: NONE")
            }

            // Phase 2d — Kills-clearing detection (uses prevDurState from before write)
            if oneHOpposes, let oneHData = oneH {
                var killsClearing = [String]()

                // Divergence: was active in PREVIOUS refresh but now cleared or weakening
                if let prev = prevDurState["divergence"], prev > 0 {
                    // Check if MACD histogram is contracting (weakening)
                    let histSeries = MACD.computeHistSeries(closes: fourH.candles.map(\.close), count: 3)
                    if histSeries.count >= 2 {
                        let latest = histSeries.last ?? 0
                        let prior = histSeries[histSeries.count - 2]
                        let dailyBearish2 = daily.bias.contains("Bearish")
                        let dailyBullish2 = daily.bias.contains("Bullish")
                        if dailyBearish2 && latest < prior { killsClearing.append("divergence_weakening") }
                        if dailyBullish2 && latest > prior { killsClearing.append("divergence_weakening") }
                    }
                }

                // Volume: was elevated, now normalizing
                if oneHData.candles.count >= 6 {
                    let recent = Array(oneHData.candles.suffix(6))
                    let latestVol = recent.last?.volume ?? 0
                    let avgVol = recent.prefix(3).map(\.volume).reduce(0, +) / 3.0
                    if avgVol > 0 && latestVol < avgVol * 0.8 {
                        killsClearing.append("volume_normalizing")
                    }
                }

                if !killsClearing.isEmpty {
                    lines.append("Kills Clearing: \(killsClearing.joined(separator: ", "))")
                }
            }

            // Phase 2c — Candle close timestamps (timezone-aware)
            let now = Date()
            let fourHInterval: TimeInterval = 4 * 3600
            let nextFourHClose = Date(timeIntervalSince1970: (floor(now.timeIntervalSince1970 / fourHInterval) + 1) * fourHInterval)

            let dailyClose: Date
            let isStock = stockInfo != nil
            if isStock {
                // Stock daily close = next 4:00 PM ET on a trading day
                let et = TimeZone(identifier: "America/New_York")!
                var cal = Calendar.current
                cal.timeZone = et
                var comps = cal.dateComponents([.year, .month, .day], from: now)
                comps.hour = 16; comps.minute = 0; comps.second = 0
                let todayClose = cal.date(from: comps) ?? now
                if now < todayClose && !MarketHours.isMarketHoliday(date: now)
                    && Calendar.current.component(.weekday, from: now) >= 2
                    && Calendar.current.component(.weekday, from: now) <= 6 {
                    dailyClose = todayClose
                } else {
                    // Next trading day — skip weekends and holidays
                    var nextDay = cal.date(byAdding: .day, value: 1, to: now) ?? now
                    while cal.component(.weekday, from: nextDay) == 1
                       || cal.component(.weekday, from: nextDay) == 7
                       || MarketHours.isMarketHoliday(date: nextDay) {
                        nextDay = cal.date(byAdding: .day, value: 1, to: nextDay) ?? nextDay
                    }
                    var nextComps = cal.dateComponents([.year, .month, .day], from: nextDay)
                    nextComps.hour = 16; nextComps.minute = 0
                    dailyClose = cal.date(from: nextComps) ?? now.addingTimeInterval(86400)
                }
            } else {
                // Crypto daily close = next midnight UTC
                var cal = Calendar.current
                cal.timeZone = TimeZone(identifier: "UTC")!
                dailyClose = cal.nextDate(after: now, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) ?? now
            }

            let isoFormatter = ISO8601DateFormatter()
            lines.append("Next 4H Close: \(isoFormatter.string(from: nextFourHClose))")
            lines.append("Next Daily Close: \(isoFormatter.string(from: dailyClose))")
        }

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
        let releasedEvents = economicEvents.filter { $0.isRecentlyReleased }
        let upcomingEvents = economicEvents.filter { $0.isUpcoming }

        if !releasedEvents.isEmpty {
            lines.append("")
            lines.append("=== RECENTLY RELEASED ECONOMIC DATA ===")
            for event in releasedEvents {
                var line = "✅ \(event.title) (\(event.country)) — Released \(event.date.formatted(date: .abbreviated, time: .shortened))"
                if let actual = event.actual, !actual.isEmpty {
                    line += " | Actual: \(actual)"
                    if let forecast = event.forecast, !forecast.isEmpty { line += " vs Exp: \(forecast)" }
                    if let surprise = event.surprise { line += " [\(surprise)]" }
                } else {
                    line += " | Actual: pending"
                    if let forecast = event.forecast, !forecast.isEmpty { line += " | Exp: \(forecast)" }
                }
                if let prev = event.previous, !prev.isEmpty { line += " | Prev: \(prev)" }
                lines.append(line)
            }
            lines.append("NOTE: These events ALREADY HAPPENED. Discuss their IMPACT on current price action, not as upcoming risk.")
        }

        if !upcomingEvents.isEmpty {
            lines.append("")
            lines.append("=== UPCOMING ECONOMIC EVENTS ===")
            for event in upcomingEvents {
                var line = "\(event.title) (\(event.country)) — \(event.date.formatted(date: .abbreviated, time: .shortened))"
                if let forecast = event.forecast, !forecast.isEmpty { line += " | Exp: \(forecast)" }
                if let prev = event.previous, !prev.isEmpty { line += " | Prev: \(prev)" }
                let hoursAway = event.date.timeIntervalSinceNow / 3600
                if hoursAway < 12 { line += " ⚠️ IN \(Int(hoursAway))H" }
                else if hoursAway < 48 { line += " ⚠️ WITHIN 48H" }
                lines.append(line)
            }
        }

        // Volatility regime + momentum alignment (market structure now per-timeframe above)
        if let daily = indicators.first {
            if let pct = daily.atrPercentile, let label = daily.atrPercentileLabel {
                lines.append("ATR Percentile: \(Int(pct))% (\(label))")
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

        // Phase 3+4 — Level proximity tagging + R:R pre-computation
        if let currentPrice = indicators.last?.price ?? indicators.first.map({ $0.price }),
           let atr = indicators.count > 2 ? indicators[2].atr?.atr : indicators[1].atr?.atr {

            // Build structured level array (used for both text output and R:R)
            struct TaggedLevel {
                let price: Double
                let type: String
                let proximity: String
                let atrDistance: Double
            }

            var allLevels = [TaggedLevel]()

            for ind in indicators {
                let prefix = ind.label
                for s in ind.supportResistance.supports {
                    let dist = abs(currentPrice - s) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: s, type: "\(prefix) support",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist))
                }
                for r in ind.supportResistance.resistances {
                    let dist = abs(currentPrice - r) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: r, type: "\(prefix) resistance",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist))
                }
                if let vwap = ind.vwap?.vwap {
                    let dist = abs(currentPrice - vwap) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: vwap, type: "\(prefix) VWAP",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist))
                }
                if let vp = ind.volumeProfile {
                    for (label, price) in [("POC", vp.poc), ("VAH", vp.valueAreaHigh), ("VAL", vp.valueAreaLow)] {
                        let dist = abs(currentPrice - price) / max(atr, 0.0001)
                        allLevels.append(TaggedLevel(price: price, type: "\(prefix) \(label)",
                            proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist))
                    }
                }
            }

            // Add MarketStructure levels with test count metadata
            for ind in indicators {
                if let ms = ind.marketStructure {
                    for level in ms.levelTests {
                        let dist = abs(currentPrice - level.price) / max(atr, 0.0001)
                        let freshness = level.candlesAgo <= 3 ? "fresh" : (level.candlesAgo <= 10 ? "recent" : "old")
                        allLevels.append(TaggedLevel(
                            price: level.price,
                            type: "\(ind.label) structure (\(level.tests)× tested, \(freshness))",
                            proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT",
                            atrDistance: dist
                        ))
                    }
                }
            }

            // Deduplicate levels within 0.1%
            var uniqueLevels = [TaggedLevel]()
            for level in allLevels {
                let isDuplicate = uniqueLevels.contains { abs($0.price - level.price) / max(level.price, 1) < 0.001 }
                if !isDuplicate { uniqueLevels.append(level) }
            }

            // Output tagged levels
            if !uniqueLevels.isEmpty {
                lines.append("")
                lines.append("=== TAGGED LEVELS ===")
                for level in uniqueLevels.prefix(15) {
                    lines.append("\(Formatters.formatPrice(level.price)) (\(level.type)) [\(level.proximity), \(String(format: "%.1f", level.atrDistance))x ATR]")
                }
            }

            // Phase 4 — R:R pre-computation from IN_PLAY levels
            if indicators.count >= 2 {
                let daily = indicators[0]
                let dailyBearish4 = daily.bias.contains("Bearish")
                let dailyBullish4 = daily.bias.contains("Bullish")
                let fourHBearish4 = indicators[1].bias.contains("Bearish")
                let fourHBullish4 = indicators[1].bias.contains("Bullish")
                let aligned4 = (dailyBearish4 && fourHBearish4) || (dailyBullish4 && fourHBullish4)
                let direction4 = dailyBearish4 ? "SHORT" : (dailyBullish4 ? "LONG" : "")

                if aligned4 && !direction4.isEmpty {
                    let entryLevels = uniqueLevels.filter { $0.proximity == "IN_PLAY" }
                    var candidates = [String]()

                    // Extract swing points for stop placement (prefer 1H, fallback 4H)
                    let h1Structure = indicators.count > 2 ? indicators[2].marketStructure : nil
                    let h4Structure = indicators.count > 1 ? indicators[1].marketStructure : nil

                    for entry in entryLevels {
                        // Stop at swing invalidation point
                        let stop: Double
                        if direction4 == "SHORT" {
                            if let swingHigh = h1Structure?.swingHighs.first ?? h4Structure?.swingHighs.first {
                                stop = swingHigh + atr * 0.3
                            } else {
                                let above = uniqueLevels.filter { $0.price > entry.price }.sorted { $0.price < $1.price }
                                stop = (above.first?.price ?? entry.price) + atr * 0.5
                            }
                        } else {
                            if let swingLow = h1Structure?.swingLows.first ?? h4Structure?.swingLows.first {
                                stop = swingLow - atr * 0.3
                            } else {
                                let below = uniqueLevels.filter { $0.price < entry.price }.sorted { $0.price > $1.price }
                                stop = (below.first?.price ?? entry.price) - atr * 0.5
                            }
                        }

                        let risk = abs(entry.price - stop)
                        guard risk > 0 else { continue }

                        // Position sizing from user settings
                        let acctSize = UserDefaults.standard.double(forKey: "accountSize")
                        let riskPct = UserDefaults.standard.double(forKey: "riskPercent")
                        let riskDollars = acctSize > 0 && riskPct > 0 ? acctSize * riskPct / 100.0 : 500.0
                        let suggestedQty = riskDollars / risk
                        let qtyStr = suggestedQty >= 1 ? String(format: "%.0f", suggestedQty) : String(format: "%.4f", suggestedQty)

                        let validTargets: [TaggedLevel]
                        if direction4 == "SHORT" {
                            validTargets = uniqueLevels.filter { $0.price < entry.price }.sorted { $0.price > $1.price }
                        } else {
                            validTargets = uniqueLevels.filter { $0.price > entry.price }.sorted { $0.price < $1.price }
                        }

                        let targetLines = validTargets.prefix(3).map { t -> String in
                            let reward = abs(t.price - entry.price)
                            let rr = reward / risk
                            return "\(Formatters.formatPrice(t.price)) (\(t.type)) R:R=\(String(format: "%.2f", rr))"
                        }

                        let viable = validTargets.prefix(3).contains { abs($0.price - entry.price) / risk >= 1.5 }

                        candidates.append(
                            "Entry \(Formatters.formatPrice(entry.price)) (\(entry.type)) | " +
                            "Stop \(Formatters.formatPrice(stop)) | " +
                            "Risk \(Formatters.formatPrice(risk)) (\(qtyStr) units @ \(Formatters.formatPrice(riskDollars)) risk) | " +
                            "Targets: \(targetLines.joined(separator: ", ")) | " +
                            "Viable: \(viable)"
                        )
                    }

                    if !candidates.isEmpty {
                        lines.append("")
                        lines.append("=== CANDIDATE SETUPS (pre-computed R:R — do not recalculate) ===")
                        for c in candidates { lines.append(c) }
                    }
                }
            }
        }

        lines.append("")

        for ind in indicators {
            lines.append("=== \(ind.label) ===")
            var biasLine = "Price: \(Formatters.formatPrice(ind.price)) | Bias: \(ind.bias) (score: \(ind.biasScore))"
            if let vs = ind.volScalar { biasLine += " [vol_scalar: \(String(format: "%.2f", vs))]" }
            if let override = ind.momentumOverride { biasLine += " [MOMENTUM: \(override)]" }
            lines.append(biasLine)

            // Per-timeframe market structure
            if let ms = ind.marketStructure {
                var msLine = "Structure: \(ms.label)"
                if !ms.swingHighs.isEmpty {
                    msLine += " | Highs: \(ms.swingHighs.prefix(3).map { Formatters.formatPrice($0) }.joined(separator: " > "))"
                }
                if !ms.swingLows.isEmpty {
                    msLine += " | Lows: \(ms.swingLows.prefix(3).map { Formatters.formatPrice($0) }.joined(separator: " > "))"
                }
                lines.append(msLine)
                for level in ms.levelTests.prefix(3) {
                    let freshness = level.candlesAgo <= 3 ? "fresh" : (level.candlesAgo <= 10 ? "recent" : "old")
                    lines.append("  \(Formatters.formatPrice(level.price)) (tested \(level.tests)×, \(freshness) — \(level.candlesAgo) candles ago)")
                }
            }

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

    /// Find local minima (troughs) in a series.
    private static func findTroughs(_ series: [Double]) -> [Double] {
        guard series.count >= 3 else { return [] }
        var troughs = [Double]()
        for i in 1..<(series.count - 1) {
            if series[i] < series[i - 1] && series[i] <= series[i + 1] {
                troughs.append(series[i])
            }
        }
        return troughs
    }

    /// Find local maxima (peaks) in a series.
    private static func findPeaks(_ series: [Double]) -> [Double] {
        guard series.count >= 3 else { return [] }
        var peaks = [Double]()
        for i in 1..<(series.count - 1) {
            if series[i] > series[i - 1] && series[i] >= series[i + 1] {
                peaks.append(series[i])
            }
        }
        return peaks
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
