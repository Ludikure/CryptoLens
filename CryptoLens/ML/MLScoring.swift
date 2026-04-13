import CoreML

/// ML scoring using dual XGBoost models converted to CoreML.
/// v6: 80 features including cross-TF interactions, temporal, rate-of-change, sentiment, ETH/BTC, raw derivatives.
/// Crypto: 150 trees (BTC/ETH/SOL/XRP). Stock: 150 trees (12 symbols).
enum MLScoring {
    private static let cryptoModel: MLModel? = {
        guard let url = Bundle.main.url(forResource: "MarketScoreML_crypto", withExtension: "mlmodelc") else {
            #if DEBUG
            print("[MLScoring] MarketScoreML_crypto.mlmodelc not found in bundle")
            #endif
            return nil
        }
        return try? MLModel(contentsOf: url)
    }()

    private static let stockModel: MLModel? = {
        guard let url = Bundle.main.url(forResource: "MarketScoreML_stock", withExtension: "mlmodelc") else {
            #if DEBUG
            print("[MLScoring] MarketScoreML_stock.mlmodelc not found in bundle")
            #endif
            return nil
        }
        return try? MLModel(contentsOf: url)
    }()

    /// Predict from expanded MLFeatures struct.
    static func predict(features f: MLFeatures, dailyScore: Int, fourHScore: Int) -> Double? {
        let model = f.isCrypto ? cryptoModel : stockModel
        guard let model else { return nil }

        // Split into sub-dicts to help Swift type-checker
        var input: [String: Double] = [:]

        // Daily core + momentum + vol/volume (19)
        let daily: [String: Double] = [
            "dRsi": f.dRsi, "dMacdHist": f.dMacdHist, "dAdx": f.dAdx,
            "dAdxBullish": f.dAdxBullish ? 1 : 0, "dEmaCross": Double(f.dEmaCross),
            "dStackBull": f.dStackBull ? 1 : 0, "dStackBear": f.dStackBear ? 1 : 0,
            "dStructBull": f.dStructBull ? 1 : 0, "dStructBear": f.dStructBear ? 1 : 0,
            "dStochK": f.dStochK, "dStochCross": Double(f.dStochCross),
            "dMacdCross": Double(f.dMacdCross), "dDivergence": Double(f.dDivergence),
            "dEma20Rising": f.dEma20Rising ? 1 : 0,
            "dBBPercentB": f.dBBPercentB, "dBBSqueeze": f.dBBSqueeze ? 1 : 0,
            "dBBBandwidth": f.dBBBandwidth, "dVolumeRatio": f.dVolumeRatio,
            "dAboveVwap": f.dAboveVwap ? 1 : 0,
        ]
        input.merge(daily) { _, new in new }

        // 4H core + momentum + vol/volume (19)
        let fourH: [String: Double] = [
            "hRsi": f.hRsi, "hMacdHist": f.hMacdHist, "hAdx": f.hAdx,
            "hAdxBullish": f.hAdxBullish ? 1 : 0, "hEmaCross": Double(f.hEmaCross),
            "hStackBull": f.hStackBull ? 1 : 0, "hStackBear": f.hStackBear ? 1 : 0,
            "hStructBull": f.hStructBull ? 1 : 0, "hStructBear": f.hStructBear ? 1 : 0,
            "hStochK": f.hStochK, "hStochCross": Double(f.hStochCross),
            "hMacdCross": Double(f.hMacdCross), "hDivergence": Double(f.hDivergence),
            "hEma20Rising": f.hEma20Rising ? 1 : 0,
            "hBBPercentB": f.hBBPercentB, "hBBSqueeze": f.hBBSqueeze ? 1 : 0,
            "hBBBandwidth": f.hBBBandwidth, "hVolumeRatio": f.hVolumeRatio,
            "hAboveVwap": f.hAboveVwap ? 1 : 0,
        ]
        input.merge(fourH) { _, new in new }

        // 1H entry + derivatives + macro + patterns + stock + context (21)
        let entry: [String: Double] = [
            "eRsi": f.eRsi, "eEmaCross": Double(f.eEmaCross),
            "eStochK": f.eStochK, "eMacdHist": f.eMacdHist,
            "fundingSignal": Double(f.fundingSignal), "oiSignal": Double(f.oiSignal),
            "takerSignal": Double(f.takerSignal), "crowdingSignal": Double(f.crowdingSignal),
            "derivativesCombined": Double(f.derivativesCombined),
            "fundingRateRaw": f.fundingRateRaw, "oiChangePct": f.oiChangePct,
            "takerRatioRaw": f.takerRatioRaw, "longPctRaw": f.longPctRaw,
            "vix": f.vix, "dxyAboveEma20": f.dxyAboveEma20 ? 1 : 0, "volScalarML": f.volScalar,
            "last3Green": f.last3Green ? 1 : 0, "last3Red": f.last3Red ? 1 : 0,
            "last3VolIncreasing": f.last3VolIncreasing ? 1 : 0,
            "obvRising": f.obvRising ? 1 : 0, "adLineAccumulation": f.adLineAccumulation ? 1 : 0,
        ]
        input.merge(entry) { _, new in new }

        // Context + cross-TF + temporal + rate-of-change (18)
        let context: [String: Double] = [
            "atrPercent": f.atrPercent, "atrPercentile": f.atrPercentile,
            "dailyScore": Double(dailyScore), "fourHScore": Double(fourHScore),
            "tfAlignment": Double(f.tfAlignment), "momentumAlignment": Double(f.momentumAlignment),
            "structureAlignment": Double(f.structureAlignment),
            "scoreSum": Double(f.scoreSum), "scoreDivergence": Double(f.scoreDivergence),
            "dayOfWeek": Double(f.dayOfWeek),
            "barsSinceRegimeChange": Double(f.barsSinceRegimeChange),
            "regimeCode": Double(f.regimeCode),
            "dRsiDelta": f.dRsiDelta, "dAdxDelta": f.dAdxDelta,
            "hRsiDelta": f.hRsiDelta, "hAdxDelta": f.hAdxDelta,
            "hMacdHistDelta": f.hMacdHistDelta,
            "fearGreedIndex": f.fearGreedIndex,
            "fearGreedZone": Double(f.fearGreedZone),
            "ethBtcRatio": f.ethBtcRatio,
            "ethBtcDelta6": f.ethBtcDelta6,
        ]
        input.merge(context) { _, new in new }

        // Volume profile + 1-bar deltas + acceleration + time-of-day (14)
        let phaseA: [String: Double] = [
            "vpDistToPocATR": f.vpDistToPocATR, "vpAbovePoc": f.vpAbovePoc ? 1 : 0,
            "vpVAWidth": f.vpVAWidth, "vpInValueArea": f.vpInValueArea ? 1 : 0,
            "vpDistToVAH_ATR": f.vpDistToVAH_ATR, "vpDistToVAL_ATR": f.vpDistToVAL_ATR,
            "hRsiDelta1": f.hRsiDelta1, "hMacdHistDelta1": f.hMacdHistDelta1,
            "dRsiDelta1": f.dRsiDelta1,
            "hRsiAccel": f.hRsiAccel, "hMacdAccel": f.hMacdAccel, "dAdxAccel": f.dAdxAccel,
            "hourBucket": Double(f.hourBucket), "isWeekend": f.isWeekend ? 1 : 0,
            "basisPct": f.basisPct, "basisExtreme": Double(f.basisExtreme),
        ]
        input.merge(phaseA) { _, new in new }

        let nsInput = input.mapValues { NSNumber(value: $0) as NSObject }
        guard let provider = try? MLDictionaryFeatureProvider(dictionary: nsInput),
              let output = try? model.prediction(from: provider) else {
            #if DEBUG
            print("[MLScoring] Prediction failed")
            #endif
            return nil
        }

        if let probs = output.featureValue(for: "classProbability")?.dictionaryValue,
           let winProb = probs[Int64(1)] as? Double {
            return winProb
        }
        #if DEBUG
        print("[MLScoring] Could not extract classProbability")
        #endif
        return nil
    }
}
