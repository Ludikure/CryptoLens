import Foundation

/// Setup-archetype classification shared with `OutcomeTracker`.
///
/// The full local prompt-construction path (`buildUserPrompt` / `systemPrompt` /
/// `parseSetups`, the A/B `promptVersion` TaskLocal, the band-default helpers, and
/// the Claude/Gemini/DeepSeek provider services) was removed once the live analysis
/// moved entirely to the Worker `/full-analysis` endpoint (see
/// `WorkerFullAnalysisService`). The Worker now builds the prompt (`src/prompt.ts`)
/// and calls the LLM server-side, so there is a single source of truth for the
/// prompt and no on-device leaked-claim drift risk.
///
/// `classifyArchetype` is the only piece the live iOS path still needs — it stamps
/// each `TrackedSetup` at registration time so `OutcomeTracker` can slice win/loss
/// by archetype later.
enum AnalysisPrompt {

    /// Setup archetype, deterministic from indicator state. Stamped on each
    /// `TrackedSetup` at registration so `OutcomeTracker` can slice win/loss by
    /// archetype.
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
}
