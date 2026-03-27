import Foundation

enum CandlePatterns {
    static func detect(opens: [Double], highs: [Double], lows: [Double], closes: [Double]) -> [PatternResult] {
        var patterns = [PatternResult]()
        guard closes.count >= 3 else { return patterns }

        let o = opens[opens.count - 1]
        let h = highs[highs.count - 1]
        let l = lows[lows.count - 1]
        let c = closes[closes.count - 1]
        let body = abs(c - o)
        let candleRange = h - l
        guard candleRange > 0 else { return patterns }

        let bodyPct = body / candleRange
        let upperWick = h - max(o, c)
        let lowerWick = min(o, c) - l

        let po = opens[opens.count - 2]
        let pc = closes[closes.count - 2]
        let prevBody = abs(pc - po)

        // Doji
        if bodyPct < 0.1 {
            patterns.append(PatternResult(pattern: "Doji", signal: "Indecision — potential reversal"))
        }
        // Hammer
        if lowerWick > 2 * body && upperWick < body * 0.5 && c >= o {
            patterns.append(PatternResult(pattern: "Hammer", signal: "Bullish reversal signal"))
        }
        // Inverted Hammer
        if upperWick > 2 * body && lowerWick < body * 0.5 && c >= o {
            patterns.append(PatternResult(pattern: "Inverted Hammer", signal: "Potential bullish reversal"))
        }
        // Shooting Star
        if upperWick > 2 * body && lowerWick < body * 0.5 && c < o {
            patterns.append(PatternResult(pattern: "Shooting Star", signal: "Bearish reversal signal"))
        }
        // Hanging Man
        if lowerWick > 2 * body && upperWick < body * 0.5 && c < o {
            patterns.append(PatternResult(pattern: "Hanging Man", signal: "Bearish reversal signal"))
        }
        // Bullish Engulfing
        if pc < po && c > o && c > po && o < pc && body > prevBody {
            patterns.append(PatternResult(pattern: "Bullish Engulfing", signal: "Strong bullish reversal"))
        }
        // Bearish Engulfing
        if pc > po && c < o && c < po && o > pc && body > prevBody {
            patterns.append(PatternResult(pattern: "Bearish Engulfing", signal: "Strong bearish reversal"))
        }
        // Morning Star (3-bar)
        let o3 = opens[opens.count - 3]
        let c3 = closes[closes.count - 3]
        if c3 < o3 && abs(pc - po) < abs(c3 - o3) * 0.3 && c > o && c > (o3 + c3) / 2 {
            patterns.append(PatternResult(pattern: "Morning Star", signal: "Bullish reversal (3-bar)"))
        }
        // Evening Star (3-bar)
        if c3 > o3 && abs(pc - po) < abs(c3 - o3) * 0.3 && c < o && c < (o3 + c3) / 2 {
            patterns.append(PatternResult(pattern: "Evening Star", signal: "Bearish reversal (3-bar)"))
        }

        return patterns
    }
}
