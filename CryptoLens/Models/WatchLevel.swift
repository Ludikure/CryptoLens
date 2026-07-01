import SwiftUI

/// A single price level worth watching — the structured, chartable version of the levels the
/// analysis discusses in prose ("$60,658 resistance", "cascade toward $59,025"). Built entirely
/// on-device from the same indicator data the worker fed the prompt (S/R, VWAP, POC/value area,
/// structure swings) plus the trade setup, so the chart shows exactly what the text is talking about.
enum WatchLevelRole {
    case resistance, support, vwap, poc, valueArea, entry, stop, target

    var color: Color {
        switch self {
        case .resistance: return .red
        case .support:    return .green
        case .vwap:       return .purple
        case .poc:        return .orange
        case .valueArea:  return Color.orange.opacity(0.75)
        case .entry:      return .cyan
        case .stop:       return .red
        case .target:     return .green
        }
    }

    /// Setup levels (entry/stop/target) are drawn dashed to distinguish them from structural S/R.
    var isSetupLevel: Bool {
        switch self { case .entry, .stop, .target: return true; default: return false }
    }

    /// Merge priority when two levels land on top of each other (keep the more actionable one).
    var priority: Int {
        switch self {
        case .entry, .stop, .target: return 5
        case .vwap: return 4
        case .poc: return 3
        case .valueArea: return 2
        case .resistance, .support: return 1
        }
    }
}

enum LevelProximity { case inPlay, nearby, distant }

struct WatchLevel: Identifiable {
    let id = UUID()
    let price: Double
    let role: WatchLevelRole
    let label: String
    let distanceATR: Double
    let proximity: LevelProximity
    let isAbove: Bool          // above the current price?
}

enum WatchLevels {
    /// Assemble the near-price levels worth watching for this analysis, ranked and de-duplicated.
    /// Filters to within ~2.5×ATR of price (the "in play" band the prompt tags), merges levels
    /// closer than 0.2×ATR (keeping the higher-priority role), and caps the count to avoid clutter.
    static func build(result: AnalysisResult, maxLevels: Int = 8) -> [WatchLevel] {
        let price = result.daily.price
        let atr = result.tf2.atr?.atr ?? result.daily.atr?.atr ?? (price * 0.01)
        guard price > 0, atr > 0 else { return [] }

        var raw: [(price: Double, role: WatchLevelRole, label: String)] = []

        // Support / resistance (daily + 4H).
        for r in result.daily.supportResistance.resistances { raw.append((r, .resistance, "Resistance")) }
        for s in result.daily.supportResistance.supports { raw.append((s, .support, "Support")) }
        for r in result.tf2.supportResistance.resistances { raw.append((r, .resistance, "Resistance")) }
        for s in result.tf2.supportResistance.supports { raw.append((s, .support, "Support")) }
        // VWAP (prefer 4H).
        if let v = (result.tf2.vwap ?? result.daily.vwap)?.vwap { raw.append((v, .vwap, "VWAP")) }
        // Volume profile.
        if let vp = result.tf2.volumeProfile ?? result.daily.volumeProfile {
            raw.append((vp.poc, .poc, "POC"))
            raw.append((vp.valueAreaHigh, .valueArea, "VAH"))
            raw.append((vp.valueAreaLow, .valueArea, "VAL"))
        }
        // Structure swing levels (recent).
        if let ms = result.tf2.marketStructure ?? result.daily.marketStructure {
            for h in ms.swingHighs.prefix(2) { raw.append((h, .resistance, "Swing high")) }
            for l in ms.swingLows.prefix(2) { raw.append((l, .support, "Swing low")) }
        }
        // Trade setup levels — always kept.
        if let setup = result.tradeSetups.first {
            raw.append((setup.entry, .entry, "Entry"))
            raw.append((setup.stopLoss, .stop, "Stop"))
            raw.append((setup.tp1, .target, "TP1"))
            if let tp2 = setup.tp2 { raw.append((tp2, .target, "TP2")) }
        }

        // Filter to the in-play band (keep all setup levels regardless of distance).
        let band = 2.5 * atr
        var kept = raw.filter { $0.role.isSetupLevel || abs($0.price - price) <= band }

        // Merge near-duplicates (within 0.2×ATR), keeping the higher-priority role.
        let mergeDist = 0.2 * atr
        kept.sort { $0.role.priority > $1.role.priority }
        var merged: [(price: Double, role: WatchLevelRole, label: String)] = []
        for lvl in kept {
            if merged.contains(where: { abs($0.price - lvl.price) < mergeDist }) { continue }
            merged.append(lvl)
        }

        // Map to WatchLevel + rank by closeness; cap the count.
        let levels = merged.map { lvl -> WatchLevel in
            let dATR = abs(lvl.price - price) / atr
            let prox: LevelProximity = dATR < 0.4 ? .inPlay : (dATR < 1.2 ? .nearby : .distant)
            return WatchLevel(price: lvl.price, role: lvl.role, label: lvl.label,
                              distanceATR: dATR, proximity: prox, isAbove: lvl.price >= price)
        }
        let sorted = levels.sorted { $0.distanceATR < $1.distanceATR }
        return Array(sorted.prefix(maxLevels)).sorted { $0.price > $1.price }
    }
}
