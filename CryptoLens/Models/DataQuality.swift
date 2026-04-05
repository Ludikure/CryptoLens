import Foundation

/// Tracks which data sources succeeded/failed before AI analysis.
struct DataQuality {
    var candlesOK = true          // Critical — abort if false
    var candleStaleness: TimeInterval = 0  // seconds since latest candle
    var sentimentOK = true
    var derivativesOK = true
    var macroOK = true
    var economicCalendarOK = true
    var stockInfoOK = true
    var spotPressureOK = true
    var weeklyContextOK = true

    /// Data sources that failed (enrichment only — candles abort separately)
    var missingEnrichments: [String] {
        var missing = [String]()
        if !sentimentOK { missing.append("sentiment") }
        if !derivativesOK { missing.append("derivatives/positioning") }
        if !macroOK { missing.append("macro (VIX/yields/DXY)") }
        if !economicCalendarOK { missing.append("economic calendar") }
        if !stockInfoOK { missing.append("stock fundamentals") }
        if !spotPressureOK { missing.append("spot pressure") }
        if !weeklyContextOK { missing.append("weekly context") }
        return missing
    }

    /// True if candle data is stale (>2x the expected interval)
    var candlesStale: Bool { candleStaleness > 7200 }  // >2h for 1H candles

    /// Summary for prompt
    var promptSection: String? {
        var lines = [String]()

        if candlesStale {
            lines.append("⚠️ Candle data may be stale — latest candle is \(Int(candleStaleness / 60)) minutes old.")
        }

        if !missingEnrichments.isEmpty {
            lines.append("Missing data: \(missingEnrichments.joined(separator: ", ")). Analysis based on available data only — do not infer missing values.")
        }

        guard !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }

    /// Short UI summary
    var uiSummary: String? {
        let missing = missingEnrichments
        if candlesStale && !missing.isEmpty {
            return "Stale candles + \(missing.count) data source(s) unavailable"
        } else if candlesStale {
            return "Candle data may be delayed"
        } else if !missing.isEmpty {
            return "\(missing.count) data source(s) unavailable"
        }
        return nil
    }
}
