import CoreML

/// ML scoring using dual XGBoost models converted to CoreML.
/// v3: 51 features including Bollinger, StochRSI, derivatives, VIX/DXY.
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

        let input: [String: Double] = [
            // Daily core
            "dRsi": f.dRsi, "dMacdHist": f.dMacdHist, "dAdx": f.dAdx,
            "dAdxBullish": f.dAdxBullish ? 1 : 0,
            "dEmaCross": Double(f.dEmaCross),
            "dStackBull": f.dStackBull ? 1 : 0, "dStackBear": f.dStackBear ? 1 : 0,
            "dStructBull": f.dStructBull ? 1 : 0, "dStructBear": f.dStructBear ? 1 : 0,
            // Daily momentum
            "dStochK": f.dStochK, "dStochCross": Double(f.dStochCross),
            "dMacdCross": Double(f.dMacdCross), "dDivergence": Double(f.dDivergence),
            "dEma20Rising": f.dEma20Rising ? 1 : 0,
            // Daily vol/volume
            "dBBPercentB": f.dBBPercentB, "dBBSqueeze": f.dBBSqueeze ? 1 : 0,
            "dBBBandwidth": f.dBBBandwidth, "dVolumeRatio": f.dVolumeRatio,
            "dAboveVwap": f.dAboveVwap ? 1 : 0,
            // 4H core
            "hRsi": f.hRsi, "hMacdHist": f.hMacdHist, "hAdx": f.hAdx,
            "hAdxBullish": f.hAdxBullish ? 1 : 0,
            "hEmaCross": Double(f.hEmaCross),
            "hStackBull": f.hStackBull ? 1 : 0, "hStackBear": f.hStackBear ? 1 : 0,
            "hStructBull": f.hStructBull ? 1 : 0, "hStructBear": f.hStructBear ? 1 : 0,
            // 4H momentum
            "hStochK": f.hStochK, "hStochCross": Double(f.hStochCross),
            "hMacdCross": Double(f.hMacdCross), "hDivergence": Double(f.hDivergence),
            "hEma20Rising": f.hEma20Rising ? 1 : 0,
            // 4H vol/volume
            "hBBPercentB": f.hBBPercentB, "hBBSqueeze": f.hBBSqueeze ? 1 : 0,
            "hBBBandwidth": f.hBBBandwidth, "hVolumeRatio": f.hVolumeRatio,
            "hAboveVwap": f.hAboveVwap ? 1 : 0,
            // 1H entry
            "eRsi": f.eRsi, "eEmaCross": Double(f.eEmaCross),
            "eStochK": f.eStochK, "eMacdHist": f.eMacdHist,
            // Derivatives
            "fundingSignal": Double(f.fundingSignal), "oiSignal": Double(f.oiSignal),
            "takerSignal": Double(f.takerSignal), "crowdingSignal": Double(f.crowdingSignal),
            "derivativesCombined": Double(f.derivativesCombined),
            // Macro
            "vix": f.vix, "dxyAboveEma20": f.dxyAboveEma20 ? 1 : 0,
            "volScalarML": f.volScalar,
            // Candle patterns
            "last3Green": f.last3Green ? 1 : 0, "last3Red": f.last3Red ? 1 : 0,
            "last3VolIncreasing": f.last3VolIncreasing ? 1 : 0,
            // Stock-only
            "obvRising": f.obvRising ? 1 : 0,
            "adLineAccumulation": f.adLineAccumulation ? 1 : 0,
            // Context
            "atrPercent": f.atrPercent, "atrPercentile": f.atrPercentile,
            "dailyScore": Double(dailyScore), "fourHScore": Double(fourHScore)
        ]

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
