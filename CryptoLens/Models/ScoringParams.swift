import Foundation

/// Tunable weights and thresholds for the scoring function.
/// The optimizer sweeps combinations of these to find optimal settings.
struct ScoringParams: Codable, Identifiable, Equatable {
    var id: String { label }

    // Layer 1: Trend
    var pricePositionWeight: Int = 2      // +-N per EMA cross level (0/1/2/3)
    var emaSlopeWeight: Int = 1           // +-N for EMA20 rising/falling
    var structureWeight: Int = 2          // +-N for HH/HL vs LL/LH
    var stackConfirmWeight: Int = 1       // +-N for stack alignment

    // Layer 2: ADX
    var adxStrongBreak: Double = 40       // ADX >= this → strong weight
    var adxModBreak: Double = 30          // ADX >= this → moderate weight
    var adxWeakBreak: Double = 20         // ADX >= this → weak weight
    var adxStrongWeight: Int = 3
    var adxModWeight: Int = 2
    var adxWeakWeight: Int = 1

    // Layer 3: Momentum
    var rsiWeight: Int = 2                // max +-N from RSI
    var macdMaxWeight: Int = 2            // max +-N from MACD (ADX-scaled)

    // Layer 4: Confirmation
    var vwapWeight: Int = 1
    var stochWeight: Int = 1
    var divergenceWeight: Int = 1

    // Layer 5: Cross-asset (daily crypto only)
    var crossAssetWeight: Int = 1         // multiplied by cross-asset signal (±2)

    // Layer 6: Derivatives (daily crypto only)
    var derivativesWeight: Int = 1        // multiplied by combined derivatives signal (±3)

    // Thresholds
    var dailyStrongThreshold: Int = 7
    var dailyDirectionalThreshold: Int = 4
    var fourHStrongThreshold: Int = 6
    var fourHDirectionalThreshold: Int = 3

    // Adaptive
    var useAdaptive: Bool = true          // scale thresholds by volScalar

    // Diagnostic mode: skip EMA structure gate + ranging override (not persisted)
    var skipGates: Bool = false

    private enum CodingKeys: String, CodingKey {
        case pricePositionWeight, emaSlopeWeight, structureWeight, stackConfirmWeight
        case adxStrongBreak, adxModBreak, adxWeakBreak, adxStrongWeight, adxModWeight, adxWeakWeight
        case rsiWeight, macdMaxWeight
        case vwapWeight, stochWeight, divergenceWeight
        case crossAssetWeight, derivativesWeight
        case dailyStrongThreshold, dailyDirectionalThreshold, fourHStrongThreshold, fourHDirectionalThreshold
        case useAdaptive
        // skipGates excluded — diagnostic-only, not persisted
    }

    // MARK: - Presets

    static var cryptoDefault: ScoringParams {
        var p = ScoringParams()
        p.pricePositionWeight = 1
        p.emaSlopeWeight = 0
        p.structureWeight = 1
        p.stackConfirmWeight = 1
        p.adxWeakWeight = 1; p.adxModWeight = 2; p.adxStrongWeight = 3
        p.rsiWeight = 3
        p.macdMaxWeight = 3
        p.vwapWeight = 0
        p.stochWeight = 0
        p.divergenceWeight = 0
        p.crossAssetWeight = 1
        p.derivativesWeight = 1
        p.dailyDirectionalThreshold = 4
        p.dailyStrongThreshold = 8
        p.fourHDirectionalThreshold = 2
        p.fourHStrongThreshold = 4
        return p
    }

    static var stockDefault: ScoringParams {
        var p = ScoringParams()
        p.pricePositionWeight = 3
        p.emaSlopeWeight = 0
        p.structureWeight = 1
        p.stackConfirmWeight = 0
        p.adxWeakWeight = 1; p.adxModWeight = 2; p.adxStrongWeight = 3
        p.rsiWeight = 3
        p.macdMaxWeight = 3
        p.vwapWeight = 1
        p.stochWeight = 0
        p.divergenceWeight = 0
        p.crossAssetWeight = 1
        p.derivativesWeight = 0
        p.dailyDirectionalThreshold = 3
        p.dailyStrongThreshold = 6
        p.fourHDirectionalThreshold = 2
        p.fourHStrongThreshold = 4
        return p
    }

    var label: String {
        "pp\(pricePositionWeight)_es\(emaSlopeWeight)_st\(structureWeight)_sc\(stackConfirmWeight)_adx\(adxStrongWeight)\(adxModWeight)\(adxWeakWeight)_r\(rsiWeight)_m\(macdMaxWeight)_v\(vwapWeight)_sk\(stochWeight)_dv\(divergenceWeight)_ca\(crossAssetWeight)_dr\(derivativesWeight)_dt\(dailyDirectionalThreshold)s\(dailyStrongThreshold)_4t\(fourHDirectionalThreshold)s\(fourHStrongThreshold)"
    }

    // MARK: - Persistence (market-specific keys)

    private static func key(for market: Market) -> String {
        "optimizer_scoring_params_\(market == .crypto ? "crypto" : "stock")"
    }

    static func loadSaved(for market: Market) -> ScoringParams? {
        guard let data = UserDefaults.standard.data(forKey: key(for: market)) else { return nil }
        return try? JSONDecoder().decode(ScoringParams.self, from: data)
    }

    func save(for market: Market) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.key(for: market))
    }

    static func clearSaved(for market: Market) {
        UserDefaults.standard.removeObject(forKey: key(for: market))
    }
}
