import CoreML

/// ML scoring using v9 dual XGBoost models. Returns a single calibrated goodR probability
/// (direction-agnostic "will there be a >=1.5 ATR favorable move within 24H"). The LLM
/// determines direction from candles and indicators.
enum MLScoring {
    private static let cryptoModel: MLModel? = loadModel("MarketScoreML_crypto")
    private static let stockModel: MLModel?  = loadModel("MarketScoreML_stock")

    private static func loadModel(_ name: String) -> MLModel? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "mlmodelc") else {
            #if DEBUG
            print("[MLScoring] \(name).mlmodelc not found in bundle")
            #endif
            return nil
        }
        return try? MLModel(contentsOf: url)
    }

    /// Predict calibrated probability of a >=1.5 ATR favorable move within 24h.
    static func predict(features f: MLFeatures) -> Double? {
        let model = f.isCrypto ? cryptoModel : stockModel
        guard let model else { return nil }
        let input = buildFeatureDict(f)
        let nsInput = input.mapValues { NSNumber(value: $0) as NSObject }
        do {
            let provider = try MLDictionaryFeatureProvider(dictionary: nsInput)
            let output = try model.prediction(from: provider)
            guard let fv = output.featureValue(for: "classProbability") else { return nil }
            let probs = fv.dictionaryValue
            guard let n = probs[Int64(1)] ?? probs[1] ?? probs["1"] else { return nil }
            return MLCalibration.calibrate(n.doubleValue, isCrypto: f.isCrypto)
        } catch {
            #if DEBUG
            print("[MLScoring] prediction threw: \(error)")
            #endif
            return nil
        }
    }

    private static func buildFeatureDict(_ f: MLFeatures) -> [String: Double] {
        var input: [String: Double] = [:]

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

        let context: [String: Double] = [
            "atrPercent": f.atrPercent, "atrPercentile": f.atrPercentile,
            "tfAlignment": Double(f.tfAlignment), "momentumAlignment": Double(f.momentumAlignment),
            "structureAlignment": Double(f.structureAlignment),
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

        let phaseA: [String: Double] = [
            "vpDistToPocATR": f.vpDistToPocATR, "vpAbovePoc": f.vpAbovePoc ? 1 : 0,
            "vpVAWidth": f.vpVAWidth, "vpInValueArea": f.vpInValueArea ? 1 : 0,
            "vpDistToVAH_ATR": f.vpDistToVAH_ATR, "vpDistToVAL_ATR": f.vpDistToVAL_ATR,
            "hRsiDelta1": f.hRsiDelta1, "hMacdHistDelta1": f.hMacdHistDelta1,
            "dRsiDelta1": f.dRsiDelta1,
            "hRsiAccel": f.hRsiAccel, "hMacdAccel": f.hMacdAccel, "dAdxAccel": f.dAdxAccel,
            "hourBucket": Double(f.hourBucket), "isWeekend": f.isWeekend ? 1 : 0,
            "basisPct": f.basisPct, "basisExtreme": Double(f.basisExtreme),
            "fiftyTwoWeekPct": f.fiftyTwoWeekPct, "distToFiftyTwoHigh": f.distToFiftyTwoHigh,
            "gapPercent": f.gapPercent, "gapFilled": f.gapFilled ? 1 : 0,
            "gapDirectionAligned": Double(f.gapDirectionAligned),
            "relStrengthVsSpy": f.relStrengthVsSpy, "beta": f.beta,
            "vixLevelCode": Double(f.vixLevelCode), "isMarketHours": f.isMarketHours ? 1 : 0,
        ]
        input.merge(phaseA) { _, new in new }

        let computed: [String: Double] = [
            "volWeightedRsi": f.dRsi * f.dVolumeRatio,
            "hVolWeightedRsi": f.hRsi * f.hVolumeRatio,
            "atrExpansionRate": 0,
            "fundingSlope": 0,
        ]
        input.merge(computed) { _, new in new }

        return input
    }
}
