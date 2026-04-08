import Foundation

/// Isolates each scoring layer's predictive power.
/// Uses cached ScoringSnapshots — no data refetch needed.
enum LayerDiagnostic {

    struct LayerResult: Identifiable {
        var id: String { name }
        let name: String
        let totalDirectional: Int
        let accuracy24H: Double
        let opportunityRate: Double
        let avgContribution: Double
    }

    /// Test each layer in isolation on Daily snapshots.
    static func diagnose(snapshots: [ScoringSnapshot]) -> [LayerResult] {
        let layerConfigs: [(String, ScoringParams)] = [
            ("Price Position (1a)", isolatedParams { $0.pricePositionWeight = 2 }),
            ("EMA Slope (1b)", isolatedParams { $0.emaSlopeWeight = 1 }),
            ("Market Structure (1c)", isolatedParams { $0.structureWeight = 2 }),
            ("EMA Stack (1d)", isolatedParams { $0.stackConfirmWeight = 1 }),
            ("ADX Direction (2)", isolatedParams { $0.adxWeakWeight = 1; $0.adxModWeight = 2; $0.adxStrongWeight = 3 }),
            ("RSI (3)", isolatedParams { $0.rsiWeight = 2 }),
            ("MACD (3)", isolatedParams { $0.macdMaxWeight = 2 }),
            ("VWAP (4)", isolatedParams { $0.vwapWeight = 1 }),
            ("Stoch RSI (4)", isolatedParams { $0.stochWeight = 1 }),
            ("Divergence (4)", isolatedParams { $0.divergenceWeight = 1 }),
            ("Cross-Asset (5)", isolatedParams { $0.crossAssetWeight = 1 }),
            ("Derivatives (6)", isolatedParams { $0.derivativesWeight = 1 }),
        ]

        return layerConfigs.map { name, params in
            evaluateLayer(name: name, params: params, snapshots: snapshots)
        }.sorted { $0.accuracy24H > $1.accuracy24H }
    }

    /// Test marginal contribution: base params vs base with one layer zeroed out.
    static func marginalContribution(snapshots: [ScoringSnapshot], baseParams: ScoringParams) -> [LayerResult] {
        let layerRemovals: [(String, (inout ScoringParams) -> Void)] = [
            ("Without Price Position", { $0.pricePositionWeight = 0 }),
            ("Without EMA Slope", { $0.emaSlopeWeight = 0 }),
            ("Without Structure", { $0.structureWeight = 0 }),
            ("Without EMA Stack", { $0.stackConfirmWeight = 0 }),
            ("Without ADX", { $0.adxWeakWeight = 0; $0.adxModWeight = 0; $0.adxStrongWeight = 0 }),
            ("Without RSI", { $0.rsiWeight = 0 }),
            ("Without MACD", { $0.macdMaxWeight = 0 }),
            ("Without VWAP", { $0.vwapWeight = 0 }),
            ("Without Stoch RSI", { $0.stochWeight = 0 }),
            ("Without Divergence", { $0.divergenceWeight = 0 }),
            ("Without Cross-Asset", { $0.crossAssetWeight = 0 }),
            ("Without Derivatives", { $0.derivativesWeight = 0 }),
        ]

        let baseResult = evaluateLayer(name: "Base (all layers)", params: baseParams, snapshots: snapshots)
        var results = [baseResult]
        for (name, remover) in layerRemovals {
            var modified = baseParams
            remover(&modified)
            results.append(evaluateLayer(name: name, params: modified, snapshots: snapshots))
        }
        return results
    }

    // MARK: - Private

    private static func isolatedParams(_ configure: (inout ScoringParams) -> Void) -> ScoringParams {
        var p = ScoringParams()
        p.pricePositionWeight = 0; p.emaSlopeWeight = 0; p.structureWeight = 0; p.stackConfirmWeight = 0
        p.adxWeakWeight = 0; p.adxModWeight = 0; p.adxStrongWeight = 0
        p.rsiWeight = 0; p.macdMaxWeight = 0
        p.vwapWeight = 0; p.stochWeight = 0; p.divergenceWeight = 0; p.crossAssetWeight = 0; p.derivativesWeight = 0
        p.dailyDirectionalThreshold = 1; p.dailyStrongThreshold = 99
        p.fourHDirectionalThreshold = 1; p.fourHStrongThreshold = 99
        p.useAdaptive = false
        configure(&p)
        return p
    }

    private static func evaluateLayer(name: String, params: ScoringParams,
                                       snapshots: [ScoringSnapshot]) -> LayerResult {
        var directional = 0, correct = 0, opportunities = 0, totalAbsScore = 0

        for snap in snapshots {
            let (score, bias) = ScoringFunction.score(snapshot: snap, params: params)
            let isBullish = bias.contains("Bullish")
            let isBearish = bias.contains("Bearish")
            totalAbsScore += abs(score)

            guard isBullish || isBearish else { continue }
            directional += 1

            if let future = snap.priceAfter24H {
                if isBullish && future > snap.price { correct += 1 }
                if isBearish && future < snap.price { correct += 1 }
            }

            if isBullish, let high = snap.forwardHigh24H, snap.price > 0 {
                if (high - snap.price) / snap.price * 100 > 1.0 { opportunities += 1 }
            }
            if isBearish, let low = snap.forwardLow24H, snap.price > 0 {
                if (snap.price - low) / snap.price * 100 > 1.0 { opportunities += 1 }
            }
        }

        return LayerResult(
            name: name,
            totalDirectional: directional,
            accuracy24H: directional > 0 ? Double(correct) / Double(directional) * 100 : 0,
            opportunityRate: directional > 0 ? Double(opportunities) / Double(directional) * 100 : 0,
            avgContribution: snapshots.count > 0 ? Double(totalAbsScore) / Double(snapshots.count) : 0
        )
    }
}
