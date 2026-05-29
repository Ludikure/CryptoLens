import Foundation

/// Shared prompt construction and response parsing for all AI providers.
enum AnalysisPrompt {

    /// A/B bucket assigned by `OutcomeTracker.assignedPromptVersion` for the current
    /// analysis run. Bound via TaskLocal at the `provider.analyze` call site in
    /// `AnalysisService` so concurrent symbol analyses each see their own bucket.
    /// Drives band-default selection (treatment uses tighter bands except for the
    /// `trendingSymbols` whitelist; baseline uses the historic wide-band logic).
    @TaskLocal static var promptVersion: String = OutcomeTracker.baselinePromptVersion

    private struct TaggedLevel {
        let price: Double
        let type: String
        let proximity: String
        let atrDistance: Double
        let strength: Double    // 0-5, composite quality
        let freshness: Double   // 0-1, recency
        let candlesAgo: Int     // raw recency (0 for non-structure)
        let isStructural: Bool  // true for MarketStructure levels
    }

    private static func computeClearance(entryPrice: Double, targetPrice: Double, allLevels: [TaggedLevel]) -> Double {
        let lo = min(entryPrice, targetPrice)
        let hi = max(entryPrice, targetPrice)
        var obstacleSum = 0.0
        for level in allLevels {
            if level.price > lo && level.price < hi {
                obstacleSum += level.strength * 0.15
            }
        }
        return max(0.0, 1.0 - obstacleSum)
    }

    /// Setup archetype, deterministic from indicator state. Used both in buildUserPrompt
    /// (to pick the failure-mode checklist and emit Archetype Track Record) and at setup
    /// registration time (so OutcomeTracker can slice win/loss by archetype later).
    static func classifyArchetype(indicators: [IndicatorResult]) -> String {
        guard indicators.count >= 2 else { return "UNCLEAR_INSUFFICIENT_DATA" }
        let daily = indicators[0]
        let fourH = indicators[1]
        let oneH = indicators.count > 2 ? indicators[2] : nil

        let dailyBull = daily.bias.contains("Bullish")
        let dailyBear = daily.bias.contains("Bearish")
        let fourHBull = fourH.bias.contains("Bullish")
        let fourHBear = fourH.bias.contains("Bearish")
        let oneHBull = oneH?.bias.contains("Bullish") ?? false
        let oneHBear = oneH?.bias.contains("Bearish") ?? false

        let dirAligned4 = (dailyBull && fourHBull) || (dailyBear && fourHBear)
        let allAligned = (dailyBull && fourHBull && oneHBull) || (dailyBear && fourHBear && oneHBear)
        let oneHCounters = dirAligned4 && ((dailyBull && oneHBear) || (dailyBear && oneHBull))
        let counterTrendDisagree = !dirAligned4 && (dailyBull || dailyBear) && (fourHBull || fourHBear)

        if counterTrendDisagree { return "COUNTER_TREND_REVERSAL" }
        if oneHCounters { return "COUNTER_TREND_PULLBACK" }
        if allAligned { return "MOMENTUM_CONTINUATION" }

        // Regime fallback (mirrors PRE-COMPUTED FLAGS regime logic)
        let adxDaily = daily.adx?.adx ?? 0
        var maAlignment = "tangled"
        if let e20 = daily.ema20, let e50 = daily.ema50, let e200 = daily.ema200 {
            if e20 > e50 && e50 > e200 { maAlignment = "bullish_stacked" }
            else if e20 < e50 && e50 < e200 { maAlignment = "bearish_stacked" }
        }
        let bbSqueezeAny = indicators.contains { $0.bollingerBands?.squeeze == true }
        if adxDaily > 25 && maAlignment != "tangled" {
            return "MOMENTUM_CONTINUATION"
        } else if bbSqueezeAny || (adxDaily >= 20 && adxDaily <= 25) {
            return "BREAKOUT_RETEST"
        } else if adxDaily < 20 {
            return "RANGE_EDGE_FADE"
        }
        return "UNCLEAR_NO_STRONG_DIRECTION"
    }

    /// Symbols with strong conditional persistence — TIGHTER TP1/TP2 (1.5/2.5 ATR vs default
    /// 2.0/4.0) gives meaningfully better expected value because the higher hit rate
    /// compensates for smaller R:R per trade. Stop floor stays at 2.0 ATR so the trade
    /// runs sub-1:1 R:R — that's intentional, the math works because of the conditional
    /// persistence (P(2.5 | 1.5) ≈ 56% on DOGE).
    ///
    /// Empirical (csv_exports_v11 DOGE, n=1937 aligned-bullish bars, 72h horizon):
    ///   - Hit rate at 1.5 ATR: 59%; at 2.5 ATR: 43%; at 2.0 ATR: 51%
    ///   - Conditional 1.5 → 2.5: 56%
    ///   - EV per trade (50% partial at TP1, BE-trail to TP2):
    ///       1.5/2.5/2.0 → +0.162 R   (this config)
    ///       1.5/2.0/2.0 → +0.149 R   (similar; TP2 slightly closer)
    ///       3.0/5.0/2.0 → +0.131 R   (old DOGE wide bands)
    ///       2.0/4.0/2.0 → +0.143 R   (default for BTC/ETH/etc.)
    ///
    /// Add a symbol here only after confirming on its own csv_exports_v11/<SYM>USDT.csv:
    ///   - aligned-bullish hit rate at 2 ATR favorable (72h horizon) >= 45%
    ///   - conditional 1.5 → 2.5 >= 50%
    private static let wideBandSymbols: Set<String> = ["DOGEUSDT"]

    /// Symbols whose 1H/4H structure historically rewards wider targets — the
    /// per-symbol EV analysis (2026-05-29 against `csv_exports_v11/` + `csv_exports_v13/`,
    /// n=237) showed these 17 see negative or near-zero edge from tighter bands. They
    /// keep the OLD wide defaults (2.0/4.0 TP1/TP2) in the treatment bucket.
    /// Edge values from that analysis (R/trade, negative = wide better):
    ///   GLD -0.0700, COIN -0.0394, PFE -0.0285, GME -0.0172, CAT -0.0107,
    ///   JUPUSDT -0.0200, TEAM/XLC/SNAP/ON/NVDA between -0.005 and 0,
    ///   INTC/MU/HBARUSDT/NEOUSDT/ENJUSDT/CMG/TIAUSDT between 0 and +0.01 (marginal).
    private static let trendingSymbols: Set<String> = [
        "GLD", "COIN", "PFE", "GME", "CAT",
        "TEAM", "XLC", "SNAP", "ON", "NVDA",
        "JUPUSDT", "INTC", "MU", "HBARUSDT", "NEOUSDT", "ENJUSDT", "CMG", "TIAUSDT"
    ]

    /// Whether this trade should use the TIGHTER (1.5 TP1 / 2.5 TP2 / 2.0 stop) band
    /// defaults. Two paths converge here:
    ///   - Baseline bucket: tighter only for `wideBandSymbols` (DOGE — preserves
    ///     the prior shipped behavior so baseline outcomes are comparable to the
    ///     pre-A/B archive).
    ///   - Treatment bucket: tighter by default; `trendingSymbols` opt out.
    /// Centralizing this here means the band-selection block below stays a single
    /// `isWideBand` switch — the meaning of that flag just depends on the bucket.
    private static func useTighterBands(symbol: String) -> Bool {
        let sym = symbol.uppercased()
        if AnalysisPrompt.promptVersion == OutcomeTracker.treatmentPromptVersion {
            return !trendingSymbols.contains(sym)
        }
        return wideBandSymbols.contains(sym)
    }

    static func systemPrompt(market: Market = .crypto, params: ScoringParams? = nil) -> String {
        _ = params  // retained for API compatibility; thresholds no longer drive prompt text
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
        The regime determines your playbook.

        STEP 2: APPLY THE RIGHT PLAYBOOK
        TRENDING: Trade WITH the trend. Entries on pullbacks to EMAs or fibs. RSI oversold in a strong trend is opportunity, not signal. Stop beyond recent HL (longs) / LH (shorts).
        RANGING: Fade the extremes. Buy support, sell resistance. RSI / Stoch RSI OB/OS are actionable here. Stops just outside the range.
        TRANSITIONING: Biggest moves start here. Bollinger squeeze + volume = highest conviction. Trade the retest of a breakout (or failed breakdown), not the breakout itself.

        STEP 3: DETERMINE YOUR DIRECTIONAL THESIS

        Read the raw data across all three timeframes. You have candles, indicators,
        structure labels, volume profile, (for crypto) derivatives positioning, and
        for stocks a "Recent News" block when company headlines were available.
        Form your own directional thesis from this evidence.

        WHEN NEWS IS PRESENT (stocks): explicitly reference it in your thesis. The numbers
        are downstream of the narrative. Examples that change conviction:
          - Earnings beat/miss within last 3 days → expect continuation of post-earnings drift
          - Regulatory / FDA / litigation news → idiosyncratic move, may override technicals
          - Sector or peer-driven news (e.g., AI selloff, banking stress) → check if this stock
            is genuinely affected or just sympathetic
          - Old news (>5 days) is usually priced in — don't double-count
        If news clearly contradicts the technical thesis (e.g., bearish setup but a strong
        upgrade just hit), name the conflict and either explain why technicals win or downgrade
        conviction / call FLAT.

        DIRECTIONAL EVIDENCE FRAMEWORK:
        The next 4H bar's direction is ~50/50 absent structural evidence (empirical, 235K stock bars). Recent direction is NOT a reliable predictor — direction confidence comes from multi-timeframe alignment, S/R / VWAP / volume profile positioning, vol regime, exhaustion vs continuation signals at key levels, and (crypto) derivatives positioning.
        Workflow: (1) read momentum from recent candles + Price Action Summary, (2) test whether structural evidence confirms continuation, suggests reversal, or stays neutral, (3) commit to a thesis only when structural evidence supports one.

        Per-timeframe role: Daily = prevailing momentum (close sequence, EMA slope). 4H = continuing or exhausting (volume trend, RSI direction, MACD hist). 1H = entry timing (Stoch RSI crosses, candle patterns at levels).

        Three states to recognize (use the pre-computed Exhaustion Signals + Continuation Signals counts in PRE-COMPUTED FLAGS):
        - MOMENTUM CONFIRMED — Continuation Signals ≥ 2 and Exhaustion Signals ≤ 1. Bias = 4H momentum direction; entry on 1H pullback.
        - MOMENTUM AMBIGUOUS — counts roughly equal, or both low. Look for market structure (HH/HL vs LL/LH), derivatives positioning, volume profile acceptance. No edge → FLAT.
        - STRUCTURAL EVIDENCE FAVORS REVERSAL — Exhaustion Signals ≥ 3 → bias = reversal direction. Exhaustion Signals 1-2 → note in Risk Factors only. Continuation and reversal carry equal evidentiary burden absent confluence — neither is the default.

        BIAS-SYMMETRY CHECK (mandatory before declaring direction):
        Empirical reality (1.34M-bar study, 2026-05): direction prediction at any horizon sits at ~50% even with the full 111-feature set. Before naming a bias, articulate BOTH sides in 2 sentences each (citing specific evidence):

        BULL CASE: [the strongest 2-sentence argument for LONG]
        BEAR CASE: [the strongest 2-sentence argument for SHORT]

        The numeric asymmetry is pre-computed as `Bias Feasibility` in PRE-COMPUTED FLAGS (LONG score / SHORT score / asymmetry / conviction_cap). Honor the conviction_cap verbatim. The narrative articulation above is still required — it forces you to look at the dissenting case. If conviction_cap is FLAT_required_close_call, mention both cases briefly but do not present a setup.

        FAILURE-MODE CHECK (mandatory before declaring conviction):
        Before naming a directional bias, write 2-3 sentences answering:
        "What would have to be true for this thesis to be wrong?"
        Concrete examples — pick the ones that apply, don't list generic risks:
        - The 4H momentum is exhaustion, not continuation — what would confirm that
          (e.g., volume divergence, RSI rolling, funding flip)?
        - The S/R level we're trading against has been broken multiple times before
          — what makes this rejection different?
        - A scheduled macro/earnings event within 24-48h could reverse the setup.
        - The ML_WIN may be elevated by features that don't apply to the current
          regime (e.g., high vol on a kill-conditions-clearing bar).
        - Multi-timeframe alignment is partial, not full — which timeframe is the weak link?
        If the failure-mode answer is "a generic move against us" — that means you don't
        have a specific failure scenario in mind, which means the conviction is not earned.
        Downgrade conviction one level OR call FLAT.

        BIAS LABEL — STRUCTURAL CONTEXT, NOT AUTHORITATIVE:
        The Daily/4H/1H bias labels in the PRE-COMPUTED FLAGS section are summary outputs
        from a scoring function over EMA stack, ADX direction, RSI regime, MACD, and (for
        daily-crypto) derivatives — a useful structural snapshot, but a SIGNAL alongside
        the raw data you analyze in Step 3, not an authority that overrides your thesis.
        Use it as a tie-breaker on ambiguous setups; do not use it to ignore exhaustion
        signals or to dismiss a 1H structural break that disagrees with a higher-TF label.

        Concrete weighting:
        - Bias label aligned with your independent thesis → conviction +1 step
        - Bias label disagrees with your thesis AND your thesis rests on 3+ exhaustion
          signals at a key level → take the trade against the label at MODERATE conviction max
        - Bias label disagrees AND your thesis only rests on momentum slope → FLAT
          (the label is signal that the structural setup hasn't actually reversed)
        - Pre-computed `divergence_against_bias` or `divergence_escalated` flag fires →
          the label itself is being challenged; weight your independent thesis higher

        If the directional thesis you wrote in Step 3 contradicts the bias label, name
        the conflict in your output ("4H label Strong Bullish but 4H closed below prior
        HL on volume → exhaustion thesis, conviction MODERATE"). Don't silently override.

        STATING YOUR THESIS:
        Declare LONG, SHORT, or FLAT with specific evidence:
        "Bias: SHORT — 4H momentum bearish (4 consecutive red bars, expanding volume).
         RSI 38 and falling. Structure LL/LH on 4H. Derivatives confirm: funding +0.04%
         (crowded long), taker flow 0.88 (sellers). 1H showing dead-cat bounce into
         4H EMA resistance at $67,500. ML_WIN: 63%.
         Failure mode: a sharp reversal would require funding to flip negative AND the 1H
         to break above the 4H EMA with expanding volume — neither is present yet."

        If FLAT — skip Step 4 entirely. Go straight to output with "NO SETUP."

        ML QUALITY FILTER (two orthogonal pre-computed flags — read both):
        Direction is your call from structure — both ML signals are direction-agnostic (~50% sign accuracy at all horizons).
        - `ML Bucket` (24h ≥1.5 ATR): trade-or-not gate. Carries the conviction ceiling and counter-trend qualification for this bar. Use the ceiling verbatim — do not re-derive from raw ML_WIN%. UNFAVORABLE bucket = NO TRADE regardless of directional clarity.
        - `ML Persistence` (72h ≥2.5 ATR): runner / exit gate. Carries TP2 multiplier, hold horizon, and partial/trailing strategy for this bar. Use its prescription verbatim — it overrides any TP2 sizing you'd otherwise derive from ATR alone.
        The two fields answer different questions (quality vs persistence) so there is no conflict to resolve. If either field is absent, judge that aspect from your own indicator analysis.

        CONVICTION (mechanical envelope, pre-computed in PRE-COMPUTED FLAGS):
        The `Conviction Envelope` field carries `max_allowed` (FLAT / LOW / MODERATE / HIGH), the specific reasons HIGH or MODERATE was blocked, the downgrade-one-tier conditions currently active, and the auto-FLAT triggers. You MAY NOT output a conviction tier above `max_allowed`. You may pick within (e.g., MODERATE-LOW if downgrade conditions apply). If `auto_FLAT_active` is non-empty, output NO SETUP regardless of any other reasoning.
        The remaining LLM judgment is two-fold: (a) is the failure mode specific to this setup (not "could go the other way") — if generic, apply the downgrade-one-tier; (b) for active trades, is the thesis still intact (no kill conditions, structure unchanged) — gates whether to follow the pre-computed Action line.

        OUTCOME HISTORY (if provided):
        Recent trade outcomes for this specific symbol are shown. Use them to:
        - Adjust directional confidence (if LONGs are winning 5/5, LONG conviction increases)
        - Flag recurring failure patterns (if SHORTs keep stopping out, require extra evidence)
        - Note ML accuracy (if setups with ML>70% are winning at expected rate, trust the ML more)
        Do NOT refuse a setup solely because the last one lost — one loss is noise, a pattern of losses is signal.

        ACTIVE TRADE MANAGEMENT:
        If an `Active Trade:` block is present in PRE-COMPUTED FLAGS, the block carries continuous values (elapsed hours, current PnL in R units, peak excursion, TP1 % reached, ML deltas, milestone flags) plus an `Action:` line with the specific instruction. Follow the `Action:` line verbatim — it's keyed on actual R values, not bucket labels. Your job is the thesis check ("is the entry thesis still intact?") which gates conditional language in the Action ("unless 4H reverses", "if kills fire"). Do not re-derive management from scratch.

        KILL CONDITION GATE (evaluate before Step 4):
        If counter_trend_pullback is true in the PRE-COMPUTED FLAGS, check kill conditions BEFORE building any setup:

        If divergence_escalated is true (6+ candles of 4H divergence against your thesis):
          → The counter-trend pullback premise has expired. This is no longer a temporary 1H counter-move — it is a potential trend transition.
          → Override bias to FLAT regardless of your directional thesis.
          → Output: "Bias: FLAT (divergence escalated — 4H divergence against your thesis for 6+ candles indicates trend transition, not pullback. Watch for 4H structural break (lower low / higher high on 4H) to confirm new direction.)"
          → Do not present any setup. State what resolves the situation: either 4H breaks structurally in the new direction (confirming transition) or divergence collapses and kills clear (restoring the original thesis).
          → Go directly to Risk Factors, then empty JSON [].

        If ANY_KILLED is true (but divergence not escalated):
          → Skip Step 4 entirely. Do not construct a setup table.
          → Output format:
            ## Bias
            "Bias: [DIRECTION]. Counter-trend entry BLOCKED: [kill flag names only, no explanation]. See Risk Factors for monitoring items."
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

        If all three exist, present the setup as a table with Entry, SL, TP1, TP2 rows showing Price, Why, and R:R.
        Rate conviction using the CONVICTION CALIBRATION rules above (mechanical, not vibes). If LOW: output "NO SETUP — [reason]" and skip the setup table.
        One line: what makes it work, what kills it.

        If two exist but one is missing, say what's missing and what to watch for.
        If no structure, say "no trade — here's what I'm watching."

        Show both directions when both have merit. Show one when only one makes sense. Show none when the market isn't giving anything. Never force it.

        COUNTER-TREND PULLBACK SETUP:
        Trigger: Daily+4H thesis is clear, but 1H moves AGAINST it. Enter with the higher-TF trend after 1H exhausts its counter-move.

        ENTRY CONDITIONS (ALL required):
        1. Daily AND 4H momentum support your thesis direction.
        2. 1H is in a counter-move against thesis (squeeze, impulse, or drift).
        3. 1H counter-move reaches a higher-TF level — shorts: 4H resistance / EMA cluster / VAH / POC. Longs: 4H support / EMA cluster / VAL / POC.
        4. 1H exhaustion at that level: rejection wick, engulfing, squeeze failure, 1H RSI divergence, volume decline on push, (crypto) taker ratio fading.

        Entry: AFTER 1H exhaustion confirms — 1H close with wick > body at the level, OR 1H close back across the level after a false breakout.
        Stop: beyond the 1H counter-move extreme. Floor 2.0× ATR(4H); structural stops wider than the floor override it.
        TP1: 2.0× ATR (1:1 with floor stop). TP2: 4.0× ATR. Snap to nearest structural level when one is in range; ATR-only targets are valid when no structure aligns.

        Kill conditions are pre-computed in PRE-COMPUTED FLAGS. Output the kill checklist (all PASS) ONLY when presenting this setup; if ANY_KILLED is true the kill gate already blocked entry.

        WAIT-FOR-CONFIRMATION: each CANDIDATE SETUP carries a Confirmation field. If the Confirmation value is not NONE, the entry MUST be presented as a conditional with the exact confirmation event written into the Entry line — never as an immediate-action price. The Entry line in the Trade Setup table must read like "$X on [Confirmation event]" (e.g., "$67500 on 1H close with wick > body" for WICK_REJECTION_CLOSE_BACK_ACROSS_LEVEL; "$67500 on volume ≥1.2× avg OR 2nd touch confirmation" for VOLUME_1.2X_OR_SECOND_TEST). The reasoning column for Entry must reference the Confirmation field by name. Confirmation NONE is the only case where an unconditional price entry is allowed (clear momentum continuation). The JSON `entry` field still emits the trigger price, but the user-facing markdown table makes the conditional nature explicit. Naked first-touch entries against the Confirmation requirement are the highest-fakeout-rate category — do not produce them.

        ENTRY RULES:
        1. Anchor primary entries to a meaningful nearby level (S/R, fib, EMA, VWAP) that price is interacting with. If the level is outside 1× ATR of current price, present the setup as a conditional ("Enter at $X on confirmation of Y") — not a current-price entry. Identified traps (bull trap, bear trap, false breakout) = no setup; do not hedge with a conditional.
        2. Calculate R:R honestly from realistic levels. Minimum 1:1. Never move the entry, stop, or target to force R:R compliance — R:R is a consequence of structure, not a target.
        3. The setup must agree with regime + bias. TRANSITIONING + FLAT = no setup. Long in a bearish regime = contradiction = no setup. FLAT / LOW conviction / ML_WIN < 50% = output "NO SETUP — [reason]" with empty JSON [] — no conditionals or hypotheticals.

        COUNTER-TREND REVERSAL SETUP (4H vs Daily divergence):
        When 4H flips against the daily trend at an inflection point, favorable excursions are frequent — but avg 24H return is near zero, so treat as a bounce, not a new trend.

        WHEN TO APPLY:
        - Daily is bearish (or strongly bearish) and 4H has flipped bullish — OR mirror image
        - ML_WIN >= 70% (required; only top-bucket quality justifies trading against the daily)

        ENTRY CONDITIONS:
        1. 4H shows clear reversal: 2+ bars in the new direction with expanding volume.
        2. Price at a key level (S/R, 52-week extreme, volume profile edge).
        3. 1H confirms — rejection wick, engulfing, or RSI cross.

        Stop: beyond the 4H reversal swing point. Floor 1.5× ATR.
        TP1: 1.0× ATR. TP2: 2.0× ATR. Tighter than aligned setups — take profit fast.
        Conviction cap: MODERATE (never HIGH; daily trend can reassert).

        DO NOT APPLY when ML_WIN < 70%, no clear 4H reversal candles (single-bar bounce), price is mid-range, or kill conditions active.

        PRICE ACTION SUMMARY:
        You receive a "Price Action Summary" section computed from raw candle data — current regime, consolidation shape, and candle patterns with position context. The momentum/volume direction is pre-computed separately (Momentum Confirmation, Volume Confirmation flags). Use the summary to answer "what is price doing right now."
        - "Hammer at support ($65,730)" is a trade trigger. "Hammer in space" is noise.

        CANDLE VERIFICATION:
        Recent candles (5 per timeframe) are included. All candles shown are CLOSED — the currently
        forming candle is excluded from indicator computation to keep values stable between refreshes.
        The "Price:" shown in each timeframe header is the last CLOSED candle's close, not the live tick.
        Before finalizing any entry:
        - Is your proposed entry within the recent candle range?
        - If price shows no momentum toward the entry level, the entry is unrealistic — revise or wait.
        - The most recent closed candle's pattern at a key level is the freshest signal available.
        - Because the display price may lag the live market by up to one candle period, propose entries
          as ranges/levels rather than exact prints when precision matters (e.g. "enter on retest of
          $X ± 0.2%" rather than "enter at $X").

        THINGS YOU KNOW:
        - Divergence is early — a warning, not an entry. Wait for price to confirm.
        - The crowd's obvious level is where stops get hunted before the move resumes.
        - The best trades feel uncomfortable. If obvious, you're probably late.
        - Overbought/oversold is a condition, not a signal. RSI 80 in a strong uptrend is strength, not a short. Treat OB/OS as actionable only when it coincides with a level + divergence or a regime change.
        - Market structure: HH/HL = bullish until broken; LL/LH = bearish until broken. Higher-TF structure overrides lower-TF. Fresh levels (1× test) get the strongest reactions; worn levels (4×+) tend to break.
        - Trades need time. Most resolve in ~40h, allow up to 72h. Frame to user as "TP/SL or re-evaluate at next Daily close" — never as "hold for X hours."

        OUTPUT FORMAT (follow this structure exactly):

        ## Market Regime
        One line: TRENDING / RANGING / TRANSITIONING. Why (reference ADX, MAs, price action summary).

        ## Key Levels
        Bullet list of the 3-5 most important levels (S/R, fib, EMA) with prices. Mark which ones price is near.

        ## Bias
        State your directional thesis with evidence and ML quality:
        "Bias: SHORT — [momentum evidence]. [Structure evidence]. [Derivatives evidence if crypto].
         ML_WIN: XX% (bucket). ML Persistence: XX% (label)."
        Always cite BOTH ML values, even if the call is FLAT — the persistence number is signal regardless of whether a trade is proposed. If the two disagree (e.g., ML_WIN TOP but Persistence WEAK), call out the disagreement in the bias narrative — it sharpens the read.

        ## Trade Setup
        Only if conviction is MODERATE or higher, bias is LONG or SHORT, AND ML_WIN >= 50% (if available). Present as a markdown table:
        | Level | Price | Why | R:R |
        |-------|-------|-----|-----|
        | Entry | $X | reason | - |
        | Stop Loss | $X | reason (min 2.0 ATR) | - |
        | TP1 | $X | reason | 1:X |
        | TP2 | $X | reason | 1:X |

        Conviction: HIGH / MODERATE / MODERATE-LOW (ML: XX%)
        Hold window: up to 72h. Re-evaluate at [next Daily close] if not triggered.
        One line: what makes it work. One line: what kills it.

        **Trade Management** (include after the setup table):
        1. At +1.0 R:R: take 50% partial, move stop to breakeven on remainder.
        2. At TP1: take another 25%, trail stop 1.0 ATR below last swing low (longs) / above swing high (shorts).
        3. Runner targets TP2.
        4. If price hasn't moved +0.5 R:R within 6 hours, tighten stop to 70% of original distance.

        If bias is FLAT, ML_WIN < 50%, or conviction is LOW:
        "NO SETUP — [specific reason]." Skip the table entirely.

        ## Risk Factors
        Maximum 3 bullets. Ranked by what is most likely to change the picture in the next 1-4 hours. Do not restate information already covered in the Bias or Trade Setup sections. Focus on:
        1. What could flip a label or clear a kill condition
        2. What external catalyst could override the technical picture
        3. Key invalidation level with specific price
        Raw data observations that diverge from pre-computed labels belong here (e.g., "4H raw data showing ascending lows — monitor for potential label flip on next refresh").

        **Next decision point:** [specific time-based event OR price level], whichever comes first.
        This must be ONE line with at most two conditions. Always include a time component (next candle close, next 4H close, specific event time) so the user knows when to look again.
        Examples: "Next decision point: 4H candle close at 6:00 PM ET or price reaching $67,663." / "Next decision point: 1H close below $66,938 or NFP release tomorrow 8:30 AM ET."

        ## Self-Check
        Mandatory verification block. One line per check, each tagged Y / N / NA, with the value or specific reason in parens:
        - Regime authoritative used as-is: Y/N (used: [REGIME])
        - Conviction within envelope: Y/N ([LEVEL] vs cap [conviction_cap value])
        - Kill conditions honored: Y/N/NA (ANY_KILLED=[true/false], action: [skipped setup / none required])
        - Bias matches feasibility favored direction: Y/N ([direction] feasibility = [N/7])
        - Failure mode specific (not generic): Y/N ([one specific failure cited])
        - Active Trade Action followed: Y/N/NA ([action: ...] → [action taken])
        Any N → fix the corresponding output section before submitting.

        ---
        At the very end, include a JSON block with trade setups:
        ```json
        [{"direction": "LONG", "entry": 65000.0, "stopLoss": 63500.0, "tp1": 67000.0, "tp2": 69000.0, "suggestedQty": 0.33, "reasoning": "Brief reason"}]
        ```
        If no valid setup, output empty array: `[]`
        Use actual prices from the data. This JSON is machine-parsed to create alerts.

        Specificity rules (enforced by ## Self-Check output block):
        - Bias must cite specific structural evidence by name (multi-TF alignment, S/R with price, volume confirmation, regime, exhaustion/continuation signal) — not vague "momentum looks bullish."
        - Failure mode must be specific to this setup — not "could go the other way."
        - Entry/SL/TP must use prices from TAGGED LEVELS or candle data — not fabricated.
        - If news present, reference it explicitly in Bias.
        - If DATA QUALITY flagged 2+ missing/stale sources, reduce conviction one level and mention in Risk Factors.

        IMPORTANT RULES:
        - ONLY reference indicator values, levels, and data points explicitly present in this payload. If a data field is not provided, state "data unavailable" — never estimate or infer missing values.
        - Keep it concise. No filler, no restating indicator values the user can already see.
        - Use ## headers exactly as shown above. The app parses these for section rendering.
        - Tables must use markdown pipe syntax with header row.
        - Do NOT list every indicator value — synthesize them into a narrative.
        - Maximum 600 words before the JSON block (headers, level lists, and table rows count toward this limit).
        - All injected timestamps in this payload are already in Eastern Time (ET). Reuse them verbatim — do not convert.

        MACRO RISK: The macro event proximity is pre-computed as `Macro Risk` in the PRE-COMPUTED FLAGS section. If IMMINENT, conviction cannot exceed LOW (no trade). If NEARBY, conviction cannot exceed MODERATE. If UPCOMING or ON_HORIZON, flag in Risk Factors but do not suppress conviction.

        TAGGED LEVELS: Levels in the TAGGED LEVELS section are pre-computed with proximity (IN_PLAY / NEARBY / DISTANT) and ATR distance. IN_PLAY levels are the only candidates for primary entries. NEARBY levels may be used for conditional/wait entries. DISTANT levels are targets only — never propose them as entries.
        CANDIDATE SETUPS: Each candidate provides a validated TP1 (R:R 1.0-2.5) and TP2 (R:R 1.8-4.0), selected by quality scoring from structural levels. Stop floors are already enforced (crypto 2.0× ATR(4H), stocks 1.5× ATR(4H)); use the candidate's Stop verbatim. If proposing an entry outside the candidates, the same floors apply. If targets show "(ATR target)" they are computed from volatility when no suitable structure existed — valid but note it. Targets marked "COUNTER-TREND" use tighter bands (TP1 R:R 0.8-1.5, TP2 R:R 1.3-2.5). If Viable: false, do NOT propose a trade.
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

            STOCK TRADE STRUCTURE (backtest-validated):
            - Default stop: 1.5x ATR (4H). Stocks have lower volatility than crypto — 2.0 ATR targets are harder to reach.
            - If the structural stop is wider than 1.5 ATR, use the structural level.
            - TP1: 1.5x ATR from entry. TP2: 3.0x ATR.
            - Hold window: up to 72h. Most stock setups resolve within 24h due to market hours.

            STOCK DIRECTIONAL RULES:
            - Stock trends are more mean-reverting than crypto. When Daily and 4H momentum DISAGREE
              (one clearly trending up, the other clearly trending down), default to FLAT. The higher-TF
              exhaustion is a stronger signal than crypto's "trade the counter-trend pullback."
            - Only take a directional trade when Daily and 4H momentum AGREE, OR when one is clearly
              exhausting with 3+ reversal signals against a stretched extreme.
            - Fundamentals (earnings, analyst revisions, insider buying) can strengthen or weaken a
              momentum thesis but should not override clear cross-TF exhaustion.


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
            - INSIDER BUYING: Cluster buying is the strongest fundamental buy signal. Weight heavily if at technical support. Individual transactions with names and dollar values are shown — a CEO buying $5M is more significant than a director buying $50K. Sells are noisier (tax/diversification) but cluster sells from multiple officers are bearish.
            - EX-DIVIDEND: If within 5 trading days, flag it. Stock gaps down by dividend amount on ex-date — don't mistake for breakdown.
            - ESTIMATE REVISIONS: Analysts revising up over 90 days = improving outlook. Revising down = deteriorating. Revision momentum leads price.
            Fundamentals don't override technicals — they add conviction or caution.
            """
        }
    }

    private static let cryptoContext = """
    CRYPTO CONTEXT:
    - Trading 24/7, no market hours.
    - Timeframes: Daily (trend context), 4H (dominant momentum signal), 1H (entry timing).
    - 4H is the primary signal layer; 1H is entry precision. 4H next-bar continuation rate has not
      been empirically measured for crypto perpetuals (stock data shows ~50%, but crypto may differ
      due to perpetual mechanics and 24/7 trading). Treat 4H direction as requiring structural
      confluence — multi-TF alignment, S/R, funding, OI, basis — not assumed continuation.
      A 1H move opposing 4H direction is either exhaustion (potential reversal) or a counter-trend
      pullback (entry opportunity); the structural evidence determines which.
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

    static func buildUserPrompt(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String,
                                stockInfo: StockInfo? = nil, derivatives: DerivativesData? = nil,
                                positioning: PositioningSnapshot? = nil, stockSentiment: StockSentimentData? = nil,
                                economicEvents: [EconomicEvent] = [], macro: MacroSnapshot? = nil,
                                weeklyContext: String? = nil, spyContext: String? = nil,
                                spotPressure: SpotPressure? = nil,
                                dataQuality: DataQuality? = nil,
                                crossAsset: CrossAssetContext? = nil,
                                outcomeHistory: [(direction: String, entry: Double, outcome: String, mlProb: Double?, conviction: String?)] = []) -> String {
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

            // Phase C10 — Conviction Envelope capture vars. Populated by the sub-blocks
            // below as their flags are computed; read at the bottom to emit the envelope.
            var envAnyKilled = false
            var envDivergenceEscalated = false
            var envMacroRisk = "NONE"
            var envContinuationCount = 0
            var envExhaustionCount = 0
            var envAlignment = "UNKNOWN"
            var envNewsConflicts = false

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
                envAnyKilled = anyKilled  // C10 capture

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
                envDivergenceEscalated = divergenceEscalated  // C10 capture

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
                envMacroRisk = macroRisk  // C10 capture
            } else {
                lines.append("Macro Risk: NONE")
                envMacroRisk = "NONE"  // C10 capture
            }

            // Phase C1 — Parabolic-move flag (mean-reversion bias on >5% crypto / >3% stock 24h move)
            if daily.candles.count >= 1, let currentPrice = indicators.first?.price, currentPrice > 0 {
                let priorDailyClose = daily.candles.last!.close
                if priorDailyClose > 0 {
                    let pct24h = (currentPrice - priorDailyClose) / priorDailyClose * 100
                    let threshold = stockInfo != nil ? 3.0 : 5.0
                    if pct24h >= threshold {
                        lines.append("Parabolic Risk: ELEVATED_LONG (24h move +\(String(format: "%.1f", pct24h))% > \(String(format: "%.0f", threshold))% — mean-reversion bias next 48h, cap conviction MODERATE on longs, tighten TP1)")
                    } else if pct24h <= -threshold {
                        lines.append("Parabolic Risk: ELEVATED_SHORT (24h move \(String(format: "%.1f", pct24h))% < -\(String(format: "%.0f", threshold))% — mean-reversion bias next 48h, cap conviction MODERATE on shorts, tighten TP1)")
                    } else {
                        lines.append("Parabolic Risk: NONE (24h move \(String(format: "%+.1f", pct24h))%)")
                    }
                }
            }

            // Phase C2 — After-Hours Entry Floor (stocks, market closed)
            if let si = stockInfo, si.marketState != "OPEN",
               let closePrice = indicators.first?.price, closePrice > 0 {
                let priceStr = Formatters.formatPrice(closePrice)
                lines.append("After-Hours Entry Floor: today's close \(priceStr). Longs must enter >= \(priceStr); shorts <= \(priceStr). Otherwise present as a conditional for next session.")
            }

            // Phase C3 — Volume Confirmation (4H last 3 bars vs trailing 20-bar avg)
            if fourH.candles.count >= 23 {
                let recent3 = Array(fourH.candles.suffix(3))
                let priorAvg = fourH.candles.dropLast(3).suffix(20).map(\.volume).reduce(0, +) / 20
                if priorAvg > 0 {
                    let recentAvg = recent3.map(\.volume).reduce(0, +) / 3
                    let volMultiple = Double(recentAvg) / Double(priorAvg)
                    let allUp = recent3.allSatisfy { $0.close > $0.open }
                    let allDown = recent3.allSatisfy { $0.close < $0.open }
                    let volStr = String(format: "%.2f", volMultiple)
                    let state: String
                    if allUp && volMultiple > 1.2 {
                        state = "CONFIRMING_UP (avg vol \(volStr)× trailing 20-bar, all 3 bars green)"
                    } else if allDown && volMultiple > 1.2 {
                        state = "CONFIRMING_DOWN (avg vol \(volStr)× trailing 20-bar, all 3 bars red)"
                    } else if allUp && volMultiple < 0.8 {
                        state = "DIVERGING_UP (price up but avg vol only \(volStr)× — hollow rally)"
                    } else if allDown && volMultiple < 0.8 {
                        state = "DIVERGING_DOWN (price down but avg vol only \(volStr)× — hollow drop)"
                    } else {
                        state = "NONE (avg vol \(volStr)×, direction mixed or volume neutral)"
                    }
                    lines.append("Volume Confirmation (4H, last 3 bars): \(state)")
                }
            }

            // Phase C4 — Momentum Confirmation pack (RSI / MACD hist / Stoch cross direction at 4H)
            let pa4H = PriceActionAnalyzer.analyze(indicator: fourH)
            var momentumParts = [String]()
            if pa4H.momentum.rsiDirection != "unknown" {
                momentumParts.append("rsi: \(pa4H.momentum.rsiDirection)")
            }
            if pa4H.momentum.macdHistDirection != "unknown" {
                momentumParts.append("macd_hist: \(pa4H.momentum.macdHistDirection)")
            }
            if !pa4H.momentum.stochCrossSignal.isEmpty {
                momentumParts.append("stoch_cross: \(pa4H.momentum.stochCrossSignal) (\(pa4H.momentum.stochCrossFreshness), \(pa4H.momentum.stochCrossAge) bars ago)")
            }
            if !momentumParts.isEmpty {
                lines.append("Momentum Confirmation (4H): \(momentumParts.joined(separator: " | "))")
            }

            // Phase C7 — Exhaustion / Continuation signal counts (4H direction-aware)
            let bullish4H = fourH.bias.contains("Bullish")
            let bearish4H = fourH.bias.contains("Bearish")
            if bullish4H || bearish4H {
                let direction = bullish4H ? "Bullish" : "Bearish"
                var exhaustion = [String]()
                var continuation = [String]()

                // 4H RSI divergence against direction
                if fourH.rsiSeries.count >= 15 && fourH.candles.count >= 15 {
                    let lookbackCandles = Array(fourH.candles.suffix(20))
                    let lookbackRSI = Array(fourH.rsiSeries.suffix(min(20, fourH.rsiSeries.count)))
                    if lookbackCandles.count == lookbackRSI.count,
                       DivergenceDetector.hasDivergence(candles: lookbackCandles, rsiSeries: lookbackRSI, biasDirection: direction) {
                        exhaustion.append(bullish4H ? "rsi_bearish_divergence" : "rsi_bullish_divergence")
                    }
                }

                // Volume direction last 3 4H bars vs trailing 20-bar avg (reuses C3 logic)
                if fourH.candles.count >= 23 {
                    let recent3 = Array(fourH.candles.suffix(3))
                    let priorAvg = fourH.candles.dropLast(3).suffix(20).map(\.volume).reduce(0, +) / 20
                    if priorAvg > 0 {
                        let recentAvg = recent3.map(\.volume).reduce(0, +) / 3
                        let volMultiple = Double(recentAvg) / Double(priorAvg)
                        let allUp = recent3.allSatisfy { $0.close > $0.open }
                        let allDown = recent3.allSatisfy { $0.close < $0.open }
                        let multStr = String(format: "%.2f", volMultiple)
                        if bullish4H && allUp && volMultiple > 1.2 { continuation.append("volume_confirming_up_\(multStr)x") }
                        else if bullish4H && allUp && volMultiple < 0.8 { exhaustion.append("volume_diverging_up_\(multStr)x") }
                        else if bearish4H && allDown && volMultiple > 1.2 { continuation.append("volume_confirming_down_\(multStr)x") }
                        else if bearish4H && allDown && volMultiple < 0.8 { exhaustion.append("volume_diverging_down_\(multStr)x") }
                    }
                }

                // Rejection wick on most recent 4H candle (against direction)
                if let last = fourH.candles.last {
                    let body = abs(last.close - last.open)
                    if body > 0 {
                        let upperWick = last.high - max(last.close, last.open)
                        let lowerWick = min(last.close, last.open) - last.low
                        if bullish4H && upperWick > body * 2 { exhaustion.append("rejection_wick_upper") }
                        else if bearish4H && lowerWick > body * 2 { exhaustion.append("rejection_wick_lower") }
                    }
                }

                // Crowded positioning against direction (crypto)
                if let pos = positioning {
                    if bullish4H && pos.crowding == .crowdedLong { exhaustion.append("crowded_longs") }
                    else if bearish4H && pos.crowding == .crowdedShort { exhaustion.append("crowded_shorts") }
                }

                // CVD divergence (spot pressure)
                if let sp = spotPressure {
                    if bullish4H && sp.cvdTrend == "Falling" { exhaustion.append("cvd_divergence_distribution") }
                    else if bearish4H && sp.cvdTrend == "Rising" { exhaustion.append("cvd_divergence_accumulation") }
                }

                // EMA stack aligned with direction (continuation)
                if let e20 = fourH.ema20, let e50 = fourH.ema50, let e200 = fourH.ema200 {
                    if bullish4H && e20 > e50 && e50 > e200 { continuation.append("ema_stack_bullish_aligned") }
                    else if bearish4H && e20 < e50 && e50 < e200 { continuation.append("ema_stack_bearish_aligned") }
                }

                // Funding rate aligned with direction (continuation, crypto)
                if let d = derivatives {
                    let fr = d.fundingRatePercent
                    if bullish4H && fr < -0.005 { continuation.append("funding_negative_supports_long") }
                    else if bearish4H && fr > 0.005 { continuation.append("funding_positive_supports_short") }
                }

                let exStr = exhaustion.isEmpty ? "0 — none" : "\(exhaustion.count) — \(exhaustion.joined(separator: ", "))"
                let contStr = continuation.isEmpty ? "0 — none" : "\(continuation.count) — \(continuation.joined(separator: ", "))"
                lines.append("Exhaustion Signals (4H, vs \(direction) momentum): \(exStr)")
                lines.append("Continuation Signals (4H, with \(direction) momentum): \(contStr)")
                envContinuationCount = continuation.count  // C10 capture
                envExhaustionCount = exhaustion.count       // C10 capture
            }

            // Phase C9 — Bias Feasibility asymmetry score (per-direction conviction-criteria check)
            do {
                func score(direction: String) -> Int {
                    var s = 0
                    let bull = direction == "LONG"
                    // 1. Daily bias
                    if bull ? daily.bias.contains("Bullish") : daily.bias.contains("Bearish") { s += 1 }
                    // 2. 4H bias
                    if bull ? fourH.bias.contains("Bullish") : fourH.bias.contains("Bearish") { s += 1 }
                    // 3. 1H bias
                    if let oneHData = oneH {
                        if bull ? oneHData.bias.contains("Bullish") : oneHData.bias.contains("Bearish") { s += 1 }
                    }
                    // 4. ML_WIN >= 70% (direction-agnostic favor, +1 both)
                    if let m = daily.mlWinProbability, m >= 0.70 { s += 1 }
                    // 5. Volume Confirmation matches direction (reuses C3 logic)
                    if fourH.candles.count >= 23 {
                        let recent3 = Array(fourH.candles.suffix(3))
                        let priorAvg = fourH.candles.dropLast(3).suffix(20).map(\.volume).reduce(0, +) / 20
                        if priorAvg > 0 {
                            let recentAvg = recent3.map(\.volume).reduce(0, +) / 3
                            let mult = Double(recentAvg) / Double(priorAvg)
                            let allUp = recent3.allSatisfy { $0.close > $0.open }
                            let allDown = recent3.allSatisfy { $0.close < $0.open }
                            if bull && allUp && mult > 1.2 { s += 1 }
                            else if !bull && allDown && mult > 1.2 { s += 1 }
                        }
                    }
                    // 6. EMA stack aligned with direction
                    if let e20 = fourH.ema20, let e50 = fourH.ema50, let e200 = fourH.ema200 {
                        if bull && e20 > e50 && e50 > e200 { s += 1 }
                        else if !bull && e20 < e50 && e50 < e200 { s += 1 }
                    }
                    // 7. Funding rate (crypto) or ML Bucket TOP (stocks)
                    if let d = derivatives {
                        let fr = d.fundingRatePercent
                        if bull && fr < -0.005 { s += 1 }
                        else if !bull && fr > 0.005 { s += 1 }
                    } else if stockInfo != nil {
                        if let m = daily.mlWinProbability, m >= 0.85 { s += 1 }
                    }
                    return s
                }
                let longScore = score(direction: "LONG")
                let shortScore = score(direction: "SHORT")
                let asymmetry = abs(longScore - shortScore)
                let favored: String
                if longScore > shortScore { favored = "LONG" }
                else if shortScore > longScore { favored = "SHORT" }
                else { favored = "NONE" }
                let cap: String
                switch asymmetry {
                case 0...2: cap = "FLAT_required_close_call"
                case 3: cap = "MODERATE_max"
                case 4...5: cap = "HIGH_allowed"
                default: cap = "HIGH_strong"
                }
                lines.append("Bias Feasibility: LONG \(longScore)/7, SHORT \(shortScore)/7 — asymmetry \(asymmetry) (favored: \(favored), conviction_cap: \(cap))")
            }

            // Phase E4 — Likely Failure Modes by setup archetype (replaces generic "what would have to be true to be wrong" answers)
            // Phase E7 — Archetype Track Record for this symbol (sliced by archetype label)
            do {
                let archetype = Self.classifyArchetype(indicators: indicators)
                let modes: [String]
                switch archetype {
                case "COUNTER_TREND_REVERSAL":
                    modes = [
                        "(a) 4H reversal was a single-bar bounce, not a structural flip — invalidated by next 4H closing back through swing point",
                        "(b) Daily trend reasserts within hours — watch for 1H structural break in daily direction within 6 bars of entry",
                        "(c) ML_WIN was elevated by features that don't apply to counter-trend regime (e.g., high vol on a kill-clearing bar)",
                        "(d) key level being faded was the wrong level — fresh 4H test at adjacent level would invalidate"
                    ]
                case "COUNTER_TREND_PULLBACK":
                    modes = [
                        "(a) higher-TF trend was actually exhausting, not pausing — confirmed by 4H structural break against thesis (LL on bullish thesis, HH on bearish)",
                        "(b) 1H exhaustion signal was a single wick, 1H continuation resumes — wait for 1H close back across the level",
                        "(c) Volume on counter-move is institutional not retail — counter_move_volume_exceeds kill condition catches this",
                        "(d) news/macro catalyst hit during the pullback window that justifies the counter-move"
                    ]
                case "MOMENTUM_CONTINUATION":
                    modes = [
                        "(a) momentum was fading not confirming — declining MACD hist on next 4H close confirms",
                        "(b) entry level held by stop hunts not real demand — invalidated by quick sweep + close back through within 1-2 bars",
                        "(c) higher-TF retracement target was already hit and exhausted — daily structure may be shifting silently",
                        "(d) Parabolic Risk flag elevated → mean-reversion bias next 48h reduces continuation probability"
                    ]
                case "RANGE_EDGE_FADE":
                    modes = [
                        "(a) range is actually breaking out — confirmed by close beyond VAH/VAL with volume >1.5× avg",
                        "(b) the level being faded has been tested 4+ times (worn) and is likely to break",
                        "(c) range is widening, not stable — recent 4H bars show ATR expansion >1.3× trailing avg",
                        "(d) macro catalyst within 4h is likely to break the range regardless of structure"
                    ]
                case "BREAKOUT_RETEST":
                    modes = [
                        "(a) the breakout was a fakeout — retest fails because the move didn't have real participation (volume <1.2× on breakout bar)",
                        "(b) you're entering the breakout bar itself, not the retest — wait for the retest, the retest IS the trade",
                        "(c) the squeeze hasn't actually fired — Bollinger bands haven't expanded materially on the breakout candle",
                        "(d) opposite kill (failed breakdown / breakout) clears the trade thesis — watch for close back inside the prior range"
                    ]
                default:
                    modes = [
                        "(a) no archetype matched — biases mixed, regime ambiguous, no strong evidence either way",
                        "(b) consider FLAT — without an archetype, the failure surface is wide and undefined"
                    ]
                }
                lines.append("Likely Failure Modes (\(archetype)):")
                for mode in modes { lines.append("  \(mode)") }

                // E7 — query OutcomeTracker for this (symbol, archetype) over last 30 days
                let record = OutcomeTracker.archetypeRecord(symbol: symbol, archetype: archetype, lookbackDays: 30)
                if record.total >= 5 {
                    let winRate = Double(record.wins) / Double(record.total) * 100
                    let verdict: String
                    if winRate >= 60 { verdict = "pattern_reliable_on_this_symbol_trust_signal" }
                    else if winRate <= 30 { verdict = "distrust_this_archetype_on_this_symbol_require_extra_confluence" }
                    else { verdict = "mixed_no_strong_edge_size_conservatively" }
                    lines.append("Archetype Track Record (\(symbol) \(archetype), 30d): \(record.wins)W \(record.losses)L (\(String(format: "%.0f", winRate))%) — \(verdict)")
                } else if record.total > 0 {
                    lines.append("Archetype Track Record (\(symbol) \(archetype), 30d): \(record.wins)W \(record.losses)L — too few samples (\(record.total)) for verdict")
                } else {
                    lines.append("Archetype Track Record (\(symbol) \(archetype), 30d): no resolved samples yet")
                }
            }

            // Phase E6 — News-Thesis Conflict (stocks, when news headlines present)
            if let si = stockInfo, let news = si.newsHeadlines, !news.isEmpty,
               fourH.bias.contains("Bullish") || fourH.bias.contains("Bearish") {
                let bullishKeywords = ["beat", "beats", "raises", "raised", "upgrade", "upgraded",
                                       "surge", "surged", "surges", "growth", "jumps", "soars",
                                       "rallies", "breakthrough", "approval", "approves",
                                       "wins", "boost", "boosts", "robust", "exceeds", "record high"]
                let bearishKeywords = ["miss", "misses", "missed", "downgrade", "downgraded",
                                       "plunge", "plunges", "slumps", "declines", "lawsuit",
                                       "sued", "investigation", "recall", "fraud", "probe",
                                       "layoffs", "slashes", "warns", "warning", "halts",
                                       "suspends", "falls", "drops", "tumbles", "sinks", "cuts"]
                var bullishHits = 0
                var bearishHits = 0
                for headline in news.prefix(8) {
                    let lower = headline.lowercased()
                    for kw in bullishKeywords where lower.contains(kw) { bullishHits += 1; break }
                    for kw in bearishKeywords where lower.contains(kw) { bearishHits += 1; break }
                }
                let biasDir = fourH.bias.contains("Bullish") ? "BULLISH" : "BEARISH"
                let newsLabel: String
                let conflictState: String
                if bullishHits >= 2 && bullishHits > bearishHits {
                    newsLabel = "BULLISH_NEWS (\(bullishHits) bull / \(bearishHits) bear keywords, last 8 headlines)"
                    conflictState = biasDir == "BULLISH" ? "SUPPORTS" : "CONFLICTS"
                } else if bearishHits >= 2 && bearishHits > bullishHits {
                    newsLabel = "BEARISH_NEWS (\(bullishHits) bull / \(bearishHits) bear keywords, last 8 headlines)"
                    conflictState = biasDir == "BEARISH" ? "SUPPORTS" : "CONFLICTS"
                } else {
                    newsLabel = "NEUTRAL_NEWS (\(bullishHits) bull / \(bearishHits) bear keywords — no strong tilt)"
                    conflictState = "NEUTRAL"
                }
                lines.append("News-Thesis Conflict: \(newsLabel) vs Bias=\(biasDir) → \(conflictState)")
                if conflictState == "CONFLICTS" {
                    lines.append("  Action: name the conflict explicitly in Bias; either justify why technicals override OR downgrade conviction / call FLAT")
                    envNewsConflicts = true  // C10 capture
                }
            }

            // Phase E1 — Multi-TF Alignment (explicit synthesis of 3 bias labels)
            do {
                let dailyDir = daily.bias.contains("Bullish") ? "Bullish" : (daily.bias.contains("Bearish") ? "Bearish" : "Neutral")
                let fourHDir = fourH.bias.contains("Bullish") ? "Bullish" : (fourH.bias.contains("Bearish") ? "Bearish" : "Neutral")
                let oneHDir = oneH.map { $0.bias.contains("Bullish") ? "Bullish" : ($0.bias.contains("Bearish") ? "Bearish" : "Neutral") } ?? "—"
                let state: String
                if dailyDir == "Bullish" && fourHDir == "Bullish" && (oneHDir == "Bullish" || oneHDir == "—") {
                    state = "ALIGNED_BULLISH"
                } else if dailyDir == "Bearish" && fourHDir == "Bearish" && (oneHDir == "Bearish" || oneHDir == "—") {
                    state = "ALIGNED_BEARISH"
                } else if dailyDir == fourHDir && dailyDir != "Neutral" {
                    state = "ALIGNED_\(dailyDir.uppercased())_HIGHER_TF_ONLY"  // 1H disagrees
                } else {
                    state = "MIXED"
                }
                lines.append("Multi-TF Alignment: \(state) (Daily \(dailyDir), 4H \(fourHDir), 1H \(oneHDir))")
                envAlignment = state  // C10 capture
            }

            // Phase E2 — Vol Regime implication (extreme high vol → mean-reversion; extreme low → expansion)
            if let pct = daily.atrPercentile {
                let pctInt = Int(pct)
                let implication: String
                if pctInt >= 85 {
                    implication = "expect_mean_reversion_next_24_48h (extreme high vol contracts)"
                } else if pctInt <= 15 {
                    implication = "expect_expansion_soon (extreme low vol expands — Bollinger squeeze territory)"
                } else if pctInt >= 70 {
                    implication = "elevated_vol_caution_on_extension_targets"
                } else if pctInt <= 30 {
                    implication = "compressed_vol_breakout_setups_favored"
                } else {
                    implication = "normal_range_no_bias"
                }
                lines.append("Vol Regime: ATR_PERCENTILE_\(pctInt) → \(implication)")
            }

            // Phase E3 — Worn Levels (4H structure levels within 2× ATR of current price)
            if let ms = fourH.marketStructure, !ms.levelTests.isEmpty,
               let currentPrice = indicators.first?.price, currentPrice > 0,
               let atr = fourH.atr?.atr, atr > 0 {
                var wornEntries = [String]()
                for level in ms.levelTests.prefix(8) {
                    let atrDist = abs(level.price - currentPrice) / atr
                    guard atrDist <= 2.0 else { continue }
                    let wear: String
                    if level.tests >= 4 { wear = "WORN_\(level.tests)x_distrust" }
                    else if level.tests >= 2 { wear = "RECENT_\(level.tests)x" }
                    else { wear = "FRESH_1x_strongest_reaction" }
                    wornEntries.append("\(Formatters.formatPrice(level.price)) [\(wear)]")
                }
                if !wornEntries.isEmpty {
                    lines.append("Worn Levels (4H, within 2× ATR of price): \(wornEntries.joined(separator: " | "))")
                }
            }

            // Phase C10 — Conviction Envelope (mechanical evaluation; replaces CONVICTION CALIBRATION prose)
            do {
                let mlPct = daily.mlWinProbability.map { Int($0 * 100) }
                let staleCount = dataQuality?.missingEnrichments.count ?? 0

                // Auto-FLAT hard gate
                var autoFlat = [String]()
                if let m = mlPct, m < 50 { autoFlat.append("ML_WIN_\(m)%<50") }
                if envAnyKilled { autoFlat.append("ANY_KILLED=true") }
                if envDivergenceEscalated { autoFlat.append("divergence_escalated_6+_candles") }
                if envAlignment == "MIXED" { autoFlat.append("biases_MIXED") }
                if envMacroRisk == "IMMINENT" { autoFlat.append("macro_IMMINENT") }

                // HIGH conviction blockers
                var highBlocks = [String]()
                if envAlignment != "ALIGNED_BULLISH" && envAlignment != "ALIGNED_BEARISH" {
                    highBlocks.append("alignment_\(envAlignment)_not_full")
                }
                if envContinuationCount < 3 {
                    highBlocks.append("continuation_\(envContinuationCount)/3+_required")
                }
                if let m = mlPct, m < 70 {
                    highBlocks.append("ML_WIN_\(m)<70")
                }
                if envMacroRisk != "NONE" && envMacroRisk != "ON_HORIZON" {
                    highBlocks.append("macro_\(envMacroRisk)_not_ON_HORIZON")
                }
                if envNewsConflicts {
                    highBlocks.append("news_thesis_conflict")
                }

                // MODERATE conviction blockers
                var moderateBlocks = [String]()
                if envContinuationCount < 2 {
                    moderateBlocks.append("continuation_\(envContinuationCount)/2+_required")
                }
                if let m = mlPct, m < 60 {
                    moderateBlocks.append("ML_WIN_\(m)<60")
                }
                if envMacroRisk != "NONE" && envMacroRisk != "ON_HORIZON" && envMacroRisk != "UPCOMING" {
                    moderateBlocks.append("macro_\(envMacroRisk)_exceeds_NEARBY")
                }

                // Downgrade-one-tier conditions (LLM applies)
                var downgrade = [String]()
                if staleCount >= 2 { downgrade.append("data_stale_\(staleCount)_sources") }
                if oneHOpposes { downgrade.append("counter_trend_pullback_cap_MODERATE") }
                // Worn level downgrade: check if any IN_PLAY 4H level has 4+ tests
                if let ms = fourH.marketStructure, let cp = indicators.first?.price, cp > 0, let a = fourH.atr?.atr, a > 0 {
                    let nearWorn = ms.levelTests.contains { abs($0.price - cp) / a <= 1.0 && $0.tests >= 4 }
                    if nearWorn { downgrade.append("entry_at_worn_level_4+_tests") }
                }

                // Determine max allowed
                let maxAllowed: String
                if !autoFlat.isEmpty {
                    maxAllowed = "FLAT"
                } else if highBlocks.isEmpty {
                    maxAllowed = "HIGH"
                } else if moderateBlocks.isEmpty {
                    maxAllowed = "MODERATE"
                } else {
                    maxAllowed = "LOW"  // = NO TRADE
                }

                lines.append("Conviction Envelope:")
                lines.append("  max_allowed: \(maxAllowed)")
                if !autoFlat.isEmpty {
                    lines.append("  auto_FLAT_active: \(autoFlat.joined(separator: ", "))")
                    lines.append("  → Output NO SETUP regardless of any other reasoning")
                } else {
                    if !highBlocks.isEmpty {
                        lines.append("  HIGH_blocked_because: \(highBlocks.joined(separator: ", "))")
                    }
                    if !moderateBlocks.isEmpty {
                        lines.append("  MODERATE_blocked_because: \(moderateBlocks.joined(separator: ", "))")
                    }
                    if !downgrade.isEmpty {
                        lines.append("  downgrade_one_tier_if_LLM_decides: \(downgrade.joined(separator: ", "))")
                    }
                    lines.append("  LLM_judgment_required: failure_mode_specific_not_generic, thesis_intact_check")
                    lines.append("  → Pick conviction within max_allowed. You may NOT output a tier above max_allowed.")
                }
            }

            // Phase C5 — ML Bucket (24h trade-quality gate; lookup derived from 1.34M-bar
            // persistence study, 2026-05). Answers ONLY: trade-or-not + conviction ceiling +
            // counter-trend qualification. TP2 sizing, hold horizon, and exit strategy are
            // answered by the separate ML Persistence (72h) field below — keeping the two
            // orthogonal so the LLM gets one recommendation per question.
            if let mlProb = daily.mlWinProbability {
                let mlPct = Int(mlProb * 100)
                let isStock = stockInfo != nil
                let bucket: String
                if isStock && mlPct >= 85 {
                    bucket = "STOCK_TOP (ML_WIN \(mlPct)%) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: yes, relaxed_confluence: 2_ok"
                } else if mlPct >= 70 {
                    bucket = "TOP (ML_WIN \(mlPct)%) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: yes"
                } else if mlPct >= 60 {
                    bucket = "FAVORABLE (ML_WIN \(mlPct)%) — direction-agnostic move quality, conviction ceiling HIGH, counter-trend qualified: no"
                } else if mlPct >= 50 {
                    bucket = "MARGINAL (ML_WIN \(mlPct)%) — direction-agnostic move quality, conviction ceiling MODERATE, counter-trend qualified: no"
                } else {
                    bucket = "UNFAVORABLE (ML_WIN \(mlPct)%) — NO TRADE regardless of directional clarity"
                }
                lines.append("ML Bucket: \(bucket)")
            }

            // ML Persistence (72h ≥2.5 ATR) — runner-hold confidence. Different question than
            // ML_WIN (24h ≥1.5 ATR which gates trade quality); answers whether to hold for TP2
            // or take TP1 fast. Top bucket reliability on out-of-sample: crypto 75.7%, stocks 77.6%.
            // ML Persistence is self-contained on TP2 sizing + hold horizon + exit strategy.
            // It doesn't depend on or reference ML Bucket — the two are orthogonal.
            // Multipliers are stocks/crypto symmetric here; stock STOCK_TOP bucket runners can
            // use the upper end of HIGH (5× ATR, wider trail) at LLM judgment.
            if let p72 = daily.mlPersistenceProbability {
                let p72Pct = Int(p72 * 100)
                let guidance: String
                if p72Pct >= 70 {
                    guidance = "HIGH (≥70%) — full 72h hold viable, TP2 at 4-5× ATR(4H), runner targets the upper multiplier, trail 1-1.5× ATR after TP1"
                } else if p72Pct >= 60 {
                    guidance = "MODERATE (60-69%) — TP2 at 3-4× ATR(4H), 48h hold target, take partial 50% at TP1 + trail the runner 1× ATR"
                } else if p72Pct >= 50 {
                    guidance = "WEAK (50-59%) — TP2 at 2-3× ATR(4H) max, 24h hold, take TP1 at +1R-1.5R and trail tightly (0.7× ATR) or exit at BE after TP1"
                } else {
                    guidance = "LOW (<50%) — do NOT hold for TP2. Take TP1 fast (+1R-1.5R) or pass the setup if TP1 < 1.5R. Persistence model expects mean-reversion before 2.5 ATR."
                }
                lines.append("ML Persistence (72h ≥2.5 ATR): \(p72Pct)% — \(guidance)")
            }

            // Phase C8 — Active Trade State (continuous values)
            // Replaces the coarse INTRA_24H/IN_PROFIT/UNDERWATER/FLAT buckets with
            // specific numbers (R units, peak excursion, TP1 % reached, ML delta
            // from registration) so the LLM can reason about edge cases without
            // having to pattern-match bucket labels.
            let activeForSymbol = OutcomeTracker.activeSetups(symbol: symbol).filter {
                $0.outcome.state == .active && $0.outcome.entryHit
            }
            if !activeForSymbol.isEmpty, let currentPrice = indicators.first?.price, currentPrice > 0 {
                let currentMLWin = indicators.first?.mlWinProbability
                let currentMLPersist = indicators.first?.mlPersistenceProbability
                for tracked in activeForSymbol {
                    guard let entryTime = tracked.outcome.entryHitTime else { continue }
                    let dir = tracked.setup.direction.uppercased()
                    let entry = tracked.setup.entry
                    let risk = tracked.setup.risk
                    guard entry > 0, risk > 0 else { continue }
                    let isLong = dir == "LONG"
                    let ageHours = Date().timeIntervalSince(entryTime) / 3600

                    // R units — primary trade-management currency. Beats raw % because
                    // it's normalized by the trade's own risk envelope.
                    let currentPnL = isLong ? (currentPrice - entry) : (entry - currentPrice)
                    let currentR = currentPnL / risk
                    let peakR = tracked.outcome.maxFavorable / risk
                    let drawdownR = tracked.outcome.maxAdverse / risk  // magnitude (>=0)

                    // TP1 progress as % of distance from entry covered at peak.
                    // Bounded [0,100] so the printed number is intuitive even on
                    // overshoot or weird stale-state edge cases.
                    let tp1Distance = abs(tracked.setup.tp1 - entry)
                    let tp1ProgressPct: Double = tp1Distance > 0
                        ? min(100, max(0, tracked.outcome.maxFavorable / tp1Distance * 100))
                        : 0

                    // Trade header — one dense line with all the numerics that matter.
                    var headerParts: [String] = []
                    headerParts.append("\(dir) entry \(Formatters.formatPrice(entry))")
                    headerParts.append(String(format: "%.0fh elapsed", ageHours))
                    headerParts.append(String(format: "PnL %+.2fR", currentR))
                    // Only print peak/drawdown when meaningfully different from current —
                    // otherwise it's noise on a flat trade.
                    if peakR > currentR + 0.2 {
                        headerParts.append(String(format: "peak +%.2fR", peakR))
                    }
                    if drawdownR > 0.2 {
                        headerParts.append(String(format: "drawdown -%.2fR", drawdownR))
                    }
                    if tp1Distance > 0 && tracked.outcome.maxFavorable > 0 {
                        headerParts.append(String(format: "TP1 %.0f%% reached", tp1ProgressPct))
                    }
                    lines.append("Active Trade: " + headerParts.joined(separator: ", "))

                    // ML deltas. Persistence wasn't stored at registration time (legacy
                    // data model), so we can only emit the current value for that one —
                    // not as informative as a delta, but still gives the LLM a fresh read.
                    if let regML = tracked.mlProbability {
                        if let cur = currentMLWin {
                            let delta = (cur - regML) * 100
                            let trend = abs(delta) < 2 ? "stable" : (delta > 0 ? "rising" : "declining")
                            lines.append(String(format: "ML Win at registration: %.0f%% | current: %.0f%% (%+.0fpp, %@)",
                                                 regML * 100, cur * 100, delta, trend))
                        } else {
                            lines.append(String(format: "ML Win at registration: %.0f%%", regML * 100))
                        }
                    }
                    if let cur = currentMLPersist {
                        lines.append(String(format: "ML Persistence current: %.0f%%", cur * 100))
                    }

                    // Management milestones — facts, not bucket labels. The LLM picks the
                    // Action from these + the R numbers above.
                    var milestones: [String] = []
                    if ageHours >= 24 { milestones.append("T+24h crossed") }
                    if ageHours >= 48 { milestones.append("T+48h crossed") }
                    if ageHours >= 72 { milestones.append("T+72h crossed") }
                    if tracked.outcome.tp1Hit { milestones.append("TP1 hit") }
                    if tracked.outcome.partialTaken { milestones.append("partial taken") }
                    if tracked.outcome.breakevenActivated { milestones.append("BE-stop active") }
                    if !milestones.isEmpty {
                        lines.append("Milestones: " + milestones.joined(separator: ", "))
                    }

                    // Action — concrete instructions keyed on actual R values, not buckets.
                    // Order matters: stop-near check fires first regardless of age, then
                    // partial-in-pocket, then profit, then flat, then pre-T+24h hold.
                    let action: String
                    if currentR <= -0.7 {
                        action = String(format: "Near stop (%.1fR). Cut at SL. No average-down, no stop widening.", currentR)
                    } else if tracked.outcome.tp1Hit && tracked.outcome.partialTaken {
                        action = "TP1 partial in pocket. Trail BE-stop on remainder. Re-evaluate at +1.5R or 48h elapsed."
                    } else if currentR >= 0.5 {
                        action = String(format: "In profit (+%.2fR). Trail stop to BE if not already. Hold to TP1 unless 4H reverses against direction.", currentR)
                    } else if ageHours < 24 {
                        action = "Pre-T+24h hold window. No mandatory action. Cut early only if thesis breaks (kills fire or 4H reverses against direction)."
                    } else {
                        action = String(format: "Flat (%+.2fR) past T+24h. Re-evaluate as if at entry. Exit at BE if kills fire or 4H structure breaks against thesis.", currentR)
                    }
                    lines.append("Action: " + action)
                }
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

            let closeFormatter = DateFormatter()
            closeFormatter.dateFormat = "MMM d, h:mm a"
            closeFormatter.timeZone = TimeZone(identifier: "America/New_York")
            closeFormatter.locale = Locale(identifier: "en_US_POSIX")
            lines.append("Next 4H Close: \(closeFormatter.string(from: nextFourHClose)) ET")
            lines.append("Next Daily Close: \(closeFormatter.string(from: dailyClose)) ET")
        }

        // Outcome history
        if outcomeHistory.count >= 3 {
            lines.append("")
            lines.append("=== RECENT OUTCOME HISTORY (\(symbol)) ===")
            let wins = outcomeHistory.filter { $0.outcome.contains("win") }.count
            let losses = outcomeHistory.filter { $0.outcome == "loss" }.count
            let total = wins + losses
            let winRate = total > 0 ? Double(wins) / Double(total) * 100 : 0
            let longs = outcomeHistory.filter { $0.direction == "LONG" }
            let shorts = outcomeHistory.filter { $0.direction == "SHORT" }
            let longWins = longs.filter { $0.outcome.contains("win") }.count
            let shortWins = shorts.filter { $0.outcome.contains("win") }.count
            lines.append("Last \(total) resolved: \(wins)W / \(losses)L (\(String(format: "%.0f", winRate))% win rate)")
            if !longs.isEmpty { lines.append("  LONG: \(longWins)/\(longs.count) won") }
            if !shorts.isEmpty { lines.append("  SHORT: \(shortWins)/\(shorts.count) won") }
            lines.append("Recent:")
            for o in outcomeHistory.prefix(3) {
                let mlStr = o.mlProb.map { " ML:\(String(format: "%.0f", $0 * 100))%" } ?? ""
                lines.append("  \(o.direction) \(Formatters.formatPrice(o.entry)) → \(o.outcome)\(mlStr)")
            }
            lines.append("Use this history to calibrate confidence. Patterns of losses in one direction = require extra evidence.")
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
            if let txs = si.insiderTransactions, !txs.isEmpty {
                let buys = txs.filter(\.isBuy)
                let sells = txs.filter { !$0.isBuy }
                let buyValue = buys.reduce(0.0) { $0 + $1.value }
                let sellValue = sells.reduce(0.0) { $0 + $1.value }
                var insiderLine = "Insider Transactions (3mo): \(buys.count) buys ($\(Formatters.compactNumber(buyValue))) / \(sells.count) sells ($\(Formatters.compactNumber(sellValue)))"
                insiderLine += buys.count > sells.count ? " — Net buying" : sells.count > buys.count ? " — Net selling" : ""
                lines.append(insiderLine)
                // Show top 3 most recent transactions with names
                let txDF = DateFormatter()
                txDF.dateFormat = "MMM d"
                for tx in txs.prefix(3) {
                    let action = tx.isBuy ? "BOUGHT" : "SOLD"
                    lines.append("  \(tx.name) \(action) \(abs(tx.shares).formatted()) shares ($\(Formatters.compactNumber(tx.value))) on \(txDF.string(from: tx.date))")
                }
            } else if let buys = si.insiderBuyCount6m, let sells = si.insiderSellCount6m {
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
            // Recent news headlines — dedicated multi-line block so the LLM can scan dates + sources.
            // Format per item: "[YYYY-MM-DD | Source] Headline" (set in FinnhubProvider.fetchNews).
            if let news = si.newsHeadlines, !news.isEmpty {
                lines.append("")
                lines.append("Recent News (last ~7d, most-recent first — read for narrative + catalysts):")
                for item in news.prefix(8) {
                    lines.append("  - \(item)")
                }
                lines.append("")
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

        let etFormatter: DateFormatter = {
            let df = DateFormatter()
            df.dateFormat = "MMM d, h:mm a"
            df.timeZone = TimeZone(identifier: "America/New_York")
            df.locale = Locale(identifier: "en_US_POSIX")
            return df
        }()

        // Cap at 12 each side. FairEconomy weeks can return 50+ events; uncapped this
        // section alone was ~30KB and a primary cause of the 413 prompt-too-long errors.
        // High-impact events are prioritized first via the existing sort upstream.
        if !releasedEvents.isEmpty {
            lines.append("")
            lines.append("=== RECENTLY RELEASED ECONOMIC DATA ===")
            for event in releasedEvents.prefix(12) {
                var line = "✅ \(event.title) (\(event.country)) — Released \(etFormatter.string(from: event.date)) ET"
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
            for event in upcomingEvents.prefix(12) {
                var line = "\(event.title) (\(event.country)) — \(etFormatter.string(from: event.date)) ET"
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
            var allLevels = [TaggedLevel]()

            for ind in indicators {
                let prefix = ind.label
                let srStrength: Double = prefix.contains("Daily") ? 2.5 : prefix.contains("4H") ? 2.0 : 1.5
                for s in ind.supportResistance.supports {
                    let dist = abs(currentPrice - s) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: s, type: "\(prefix) support",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist,
                        strength: srStrength, freshness: 1.0, candlesAgo: 0, isStructural: false))
                }
                for r in ind.supportResistance.resistances {
                    let dist = abs(currentPrice - r) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: r, type: "\(prefix) resistance",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist,
                        strength: srStrength, freshness: 1.0, candlesAgo: 0, isStructural: false))
                }
                if let vwap = ind.vwap?.vwap {
                    let dist = abs(currentPrice - vwap) / max(atr, 0.0001)
                    allLevels.append(TaggedLevel(price: vwap, type: "\(prefix) VWAP",
                        proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist,
                        strength: 2.0, freshness: 0.5, candlesAgo: 0, isStructural: false))
                }
                if let vp = ind.volumeProfile {
                    for (label, price) in [("POC", vp.poc), ("VAH", vp.valueAreaHigh), ("VAL", vp.valueAreaLow)] {
                        let dist = abs(currentPrice - price) / max(atr, 0.0001)
                        allLevels.append(TaggedLevel(price: price, type: "\(prefix) \(label)",
                            proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT", atrDistance: dist,
                            strength: label == "POC" ? 3.5 : 3.0, freshness: 1.0, candlesAgo: 0, isStructural: false))
                    }
                }
            }

            // Add MarketStructure levels with test count metadata
            for ind in indicators {
                if let ms = ind.marketStructure {
                    let tfWeight: Double = ind.label.contains("Daily") ? 1.5 : ind.label.contains("4H") ? 1.0 : 0.5
                    for level in ms.levelTests {
                        let dist = abs(currentPrice - level.price) / max(atr, 0.0001)
                        let freshnessText = level.candlesAgo <= 3 ? "fresh" : (level.candlesAgo <= 10 ? "recent" : "old")
                        let levelStrength = min(Double(min(level.tests, 5)) * tfWeight, 5.0)
                        let levelFreshness: Double = level.candlesAgo <= 3 ? 1.0 : level.candlesAgo <= 10 ? 0.5 : 0.0
                        allLevels.append(TaggedLevel(
                            price: level.price,
                            type: "\(ind.label) structure (\(level.tests)× tested, \(freshnessText))",
                            proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT",
                            atrDistance: dist,
                            strength: levelStrength, freshness: levelFreshness,
                            candlesAgo: level.candlesAgo, isStructural: true
                        ))
                    }
                }
            }

            // Confluence clustering: merge levels within 0.3 ATR
            var clustered = [TaggedLevel]()
            let sortedLevels = allLevels.sorted { $0.price < $1.price }
            var used = Set<Int>()
            for i in sortedLevels.indices where !used.contains(i) {
                var clusterIndices = [i]
                for j in (i + 1)..<sortedLevels.count where !used.contains(j) {
                    if abs(sortedLevels[j].price - sortedLevels[i].price) / max(atr, 0.0001) <= 0.3 {
                        clusterIndices.append(j)
                    } else { break }
                }
                clusterIndices.forEach { used.insert($0) }
                let members = clusterIndices.map { sortedLevels[$0] }
                let anchor = members.max(by: { $0.strength < $1.strength })!
                let totalStrength = min(members.reduce(0.0) { $0 + $1.strength }, 5.0)
                let bestFreshness = members.map(\.freshness).max() ?? 0
                let minCandlesAgo = members.map(\.candlesAgo).min() ?? 0
                let anyStructural = members.contains { $0.isStructural }
                let typeStr = members.count == 1 ? anchor.type : members.map(\.type).joined(separator: " + ")
                let dist = abs(currentPrice - anchor.price) / max(atr, 0.0001)
                clustered.append(TaggedLevel(
                    price: anchor.price, type: typeStr,
                    proximity: dist <= 1.0 ? "IN_PLAY" : dist <= 2.0 ? "NEARBY" : "DISTANT",
                    atrDistance: dist, strength: totalStrength, freshness: bestFreshness,
                    candlesAgo: minCandlesAgo, isStructural: anyStructural
                ))
            }
            let uniqueLevels = clustered

            // Output tagged levels
            if !uniqueLevels.isEmpty {
                lines.append("")
                lines.append("=== TAGGED LEVELS ===")
                for level in uniqueLevels.prefix(15) {
                    lines.append("\(Formatters.formatPrice(level.price)) (\(level.type)) [\(level.proximity), \(String(format: "%.1f", level.atrDistance))x ATR, str=\(String(format: "%.1f", level.strength))]")
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
                let isCounterTrend = !aligned4 && !direction4.isEmpty

                // Mirror of PRE-COMPUTED FLAGS regime logic (the outer scope's `regime` doesn't reach here)
                let adxDaily4 = daily.adx?.adx ?? 0
                var maAlignment4 = "tangled"
                if let e20 = daily.ema20, let e50 = daily.ema50, let e200 = daily.ema200 {
                    if e20 > e50 && e50 > e200 { maAlignment4 = "bullish_stacked" }
                    else if e20 < e50 && e50 < e200 { maAlignment4 = "bearish_stacked" }
                }
                let bbSqueezeAny4 = indicators.contains { $0.bollingerBands?.squeeze == true }
                let regime: String
                if adxDaily4 > 25 && maAlignment4 != "tangled" { regime = "TRENDING" }
                else if bbSqueezeAny4 || (adxDaily4 >= 20 && adxDaily4 <= 25) { regime = "TRANSITIONING" }
                else if adxDaily4 < 20 { regime = "RANGING" }
                else { regime = "TRANSITIONING" }

                if !direction4.isEmpty {
                    let effectiveDirection = direction4
                    let entryLevels = uniqueLevels.filter { $0.proximity == "IN_PLAY" }
                    var candidates = [String]()

                    // Extract swing points for stop placement (prefer 1H, fallback 4H)
                    let h1Structure = indicators.count > 2 ? indicators[2].marketStructure : nil
                    let h4Structure = indicators.count > 1 ? indicators[1].marketStructure : nil

                    for entry in entryLevels {
                        // Stop at swing invalidation point
                        let stop: Double
                        if effectiveDirection == "SHORT" {
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

                        // Enforce minimum stop distance of 2.0 ATR (backtest-proven optimal)
                        var adjustedStop = stop
                        let minStopDist = atr * 2.0
                        if abs(entry.price - adjustedStop) < minStopDist {
                            adjustedStop = effectiveDirection == "SHORT" ? entry.price + minStopDist : entry.price - minStopDist
                        }
                        let risk = abs(entry.price - adjustedStop)
                        guard risk > 0 else { continue }

                        // Position sizing from user settings
                        let acctSize = UserDefaults.standard.double(forKey: "accountSize")
                        let riskPct = UserDefaults.standard.double(forKey: "riskPercent")
                        let riskDollars = acctSize > 0 && riskPct > 0 ? acctSize * riskPct / 100.0 : 500.0
                        let suggestedQty = riskDollars / risk
                        let qtyStr = suggestedQty >= 1 ? String(format: "%.0f", suggestedQty) : String(format: "%.4f", suggestedQty)

                        // R:R / ATR bands. Counter-trend always uses tight bands. For trend-aligned
                        // setups, the historical favorable-excursion distribution justifies a tighter
                        // TP1 band on most symbols: at 2 ATR favorable, aligned-bullish bars hit only
                        // ~22% of the time on BTC/ETH/SOL/XRP/ADA and ~26% on stocks, vs ~32% at 1.5
                        // ATR — the 1.0-1.5 ATR range is where the distribution actually concentrates.
                        // Wide-band symbols (DOGE-like) use TIGHTER TP1/TP2 than the default (1.5 / 2.5
                        // ATR rather than 2.0 / 4.0). The conditional persistence 1.5 → 2.5 ≈ 56% on
                        // DOGE is strong enough that the higher hit rate beats the lower R:R per trade
                        // in expected value (+0.162 R/trade vs +0.131 for the old 3.0/5.0 wide bands;
                        // see wideBandSymbols doc-comment for the full backtest table). Stop floor
                        // stays at 2.0 ATR so the trade runs sub-1:1 R:R — that's intentional.
                        let isWideBand = Self.useTighterBands(symbol: symbol)
                        let tp1RRBand: (Double, Double)
                        let tp1ATRBand: (Double, Double)
                        let idealTP1RR: Double
                        if isCounterTrend {
                            tp1RRBand = (0.8, 1.5)
                            tp1ATRBand = (0.5, 2.0)
                            idealTP1RR = 1.0
                        } else if isWideBand {
                            // TP1 at ~1.5 ATR with 2.0 ATR stop → 0.75 R:R. Sub-1 R:R intentional.
                            tp1RRBand = (0.5, 1.0)
                            tp1ATRBand = (1.0, 2.0)
                            idealTP1RR = 0.75
                        } else {
                            tp1RRBand = (1.0, 1.7)
                            tp1ATRBand = (0.8, 2.0)
                            idealTP1RR = 1.3
                        }
                        let tp2RRBand: (Double, Double)
                        let tp2ATRBand: (Double, Double)
                        let idealTP2RR: Double
                        if isCounterTrend {
                            tp2RRBand = (1.3, 2.5)
                            tp2ATRBand = (1.0, 3.5)
                            idealTP2RR = 1.8
                        } else if isWideBand {
                            // TP2 at ~2.5 ATR with 2.0 ATR stop → 1.25 R:R.
                            tp2RRBand = (0.75, 1.5)
                            tp2ATRBand = (2.0, 3.0)
                            idealTP2RR = 1.25
                        } else {
                            tp2RRBand = (1.3, 4.0)
                            tp2ATRBand = (1.5, 5.0)
                            idealTP2RR = 2.5
                        }

                        let directionalLevels: [TaggedLevel]
                        if effectiveDirection == "SHORT" {
                            directionalLevels = uniqueLevels.filter { $0.price < entry.price }
                        } else {
                            directionalLevels = uniqueLevels.filter { $0.price > entry.price }
                        }

                        // Layer 1+2: filter by band, score by quality
                        func tp1Score(_ level: TaggedLevel) -> Double? {
                            let reward = abs(level.price - entry.price)
                            let rr = reward / risk
                            let atrDist = reward / max(atr, 0.0001)
                            guard rr >= tp1RRBand.0 && rr <= tp1RRBand.1 && atrDist >= tp1ATRBand.0 && atrDist <= tp1ATRBand.1 else { return nil }
                            let rrFit = max(0, 1.0 - abs(rr - idealTP1RR) / idealTP1RR)
                            let clearance = Self.computeClearance(entryPrice: entry.price, targetPrice: level.price, allLevels: uniqueLevels)
                            return 1.5 * level.strength + 1.0 * rrFit + 1.0 * clearance + 0.5 * level.freshness
                        }

                        let tp1 = directionalLevels.compactMap { l in tp1Score(l).map { (l, $0) } }.max(by: { $0.1 < $1.1 })?.0

                        let tp1RR = tp1.map { abs($0.price - entry.price) / risk } ?? 0
                        let tp2MinRR = max(tp2RRBand.0, tp1RR + 0.3)

                        func tp2Score(_ level: TaggedLevel) -> Double? {
                            let reward = abs(level.price - entry.price)
                            let rr = reward / risk
                            let atrDist = reward / max(atr, 0.0001)
                            guard rr >= tp2MinRR && rr <= tp2RRBand.1 && atrDist >= tp2ATRBand.0 && atrDist <= tp2ATRBand.1 else { return nil }
                            // TP2 must be at least 0.5 ATR beyond TP1
                            let distFromTP1 = abs(level.price - (tp1?.price ?? entry.price))
                            guard distFromTP1 / max(atr, 0.0001) >= 0.5 else { return nil }
                            if let t1 = tp1 {
                                guard effectiveDirection == "SHORT" ? level.price < t1.price : level.price > t1.price else { return nil }
                            }
                            let rrFit = max(0, 1.0 - abs(rr - idealTP2RR) / idealTP2RR)
                            let clearance = Self.computeClearance(entryPrice: tp1?.price ?? entry.price, targetPrice: level.price, allLevels: uniqueLevels)
                            return 1.5 * level.strength + 1.0 * rrFit + 1.0 * clearance + 0.5 * level.freshness
                        }

                        let tp2 = directionalLevels.compactMap { l in tp2Score(l).map { (l, $0) } }.max(by: { $0.1 < $1.1 })?.0

                        // Layer 3: ATR fallback with snap-to-level
                        func atrFallback(_ multiplier: Double, _ label: String) -> (price: Double, type: String) {
                            let fp = effectiveDirection == "SHORT" ? entry.price - atr * multiplier : entry.price + atr * multiplier
                            if let nearest = uniqueLevels.min(by: { abs($0.price - fp) < abs($1.price - fp) }),
                               abs(nearest.price - fp) / max(atr, 0.0001) <= 0.5 {
                                return (nearest.price, "ATR target (\(label)) → \(nearest.type)")
                            }
                            return (fp, "ATR target (\(label))")
                        }

                        let finalTP1Price: Double
                        let finalTP1Type: String
                        if let t1 = tp1 { finalTP1Price = t1.price; finalTP1Type = t1.type }
                        else {
                            // Fallback ATR multiplier matches the band's ideal:
                            // wideBand → 1.5× (band [1.0, 2.0], ideal 0.75 R:R = 1.5 ATR)
                            // counter-trend → 1.5× (kept from prior behavior)
                            // default → 1.2× (band [0.8, 2.0])
                            let fbMult = isWideBand ? 1.5 : (isCounterTrend ? 1.5 : 1.2)
                            let fbLabel = String(format: "%.1f× ATR", fbMult)
                            let fb = atrFallback(fbMult, fbLabel); finalTP1Price = fb.price; finalTP1Type = fb.type
                        }

                        let finalTP2Price: Double
                        let finalTP2Type: String
                        if let t2 = tp2 { finalTP2Price = t2.price; finalTP2Type = t2.type }
                        else {
                            // wideBand TP2 ideal is 2.5× ATR (1.25 R:R), others stay at 2.5× too
                            // (that's the default idealTP2RR with 2 ATR stop = 5 ATR target — but
                            // ATR-fallback uses a smaller anchor since structure was missing entirely).
                            let fb = atrFallback(isWideBand ? 2.5 : 2.5, "2.5× ATR")
                            finalTP2Price = fb.price; finalTP2Type = fb.type
                        }

                        let finalTP1RR = abs(finalTP1Price - entry.price) / risk
                        let finalTP2RR = abs(finalTP2Price - entry.price) / risk

                        let targetLines = [
                            "\(Formatters.formatPrice(finalTP1Price)) (\(finalTP1Type)) R:R=\(String(format: "%.2f", finalTP1RR))",
                            "\(Formatters.formatPrice(finalTP2Price)) (\(finalTP2Type)) R:R=\(String(format: "%.2f", finalTP2RR))"
                        ]
                        // Viable floor: wideBand setups intentionally run sub-1:1 R:R (the
                        // conditional persistence on these symbols compensates — see
                        // wideBandSymbols doc-comment for the EV math).
                        let viable = finalTP1RR >= (isCounterTrend ? 0.8 : isWideBand ? 0.5 : 1.0)

                        let setupLabel = isCounterTrend ? "COUNTER-TREND" : "TREND"

                        // Phase C6 — Confirmation Required (replaces WAIT-FOR-CONFIRMATION RULE)
                        let confirmation: String
                        if isCounterTrend {
                            confirmation = "WICK_REJECTION_CLOSE_BACK_ACROSS_LEVEL"
                        } else if regime == "TRENDING" {
                            confirmation = "VOLUME_1.2X_OR_SECOND_TEST"
                        } else {
                            confirmation = "NONE"
                        }

                        candidates.append(
                            "[\(setupLabel)] Entry \(Formatters.formatPrice(entry.price)) (\(entry.type)) | " +
                            "Stop \(Formatters.formatPrice(adjustedStop)) | " +
                            "Risk \(Formatters.formatPrice(risk)) (\(qtyStr) units @ \(Formatters.formatPrice(riskDollars)) risk) | " +
                            "TP1: \(targetLines[0]) | TP2: \(targetLines[1]) | " +
                            "Confirmation: \(confirmation) | " +
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
            var biasLine = "Price: \(Formatters.formatPrice(ind.price))"
            if let ml = ind.mlWinProbability { biasLine += " | ML_WIN: \(Int(ml * 100))%" }
            if let vs = ind.volScalar { biasLine += " [vol_scalar: \(String(format: "%.2f", vs))]" }
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
            if !maParts.isEmpty { lines.append("MAs: \(maParts.joined(separator: " "))") }

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
