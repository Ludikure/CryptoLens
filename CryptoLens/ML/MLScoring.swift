import CoreML

/// ML scoring using dual XGBoost models converted to CoreML.
/// Crypto model: 150 trees, trained on BTC/ETH/SOL/XRP.
/// Stock model: 50 trees, trained on AAPL/MSFT/NVDA/TSLA/AMZN.
/// Returns probability of resolved win (TP hit before SL).
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

    /// Returns probability of resolved win (0.0 to 1.0), or nil if model unavailable.
    static func predict(
        dRsi: Double, dMacdHist: Double, dAdx: Double, dAdxBullish: Bool,
        dEmaCross: Int, dStackBull: Bool, dStackBear: Bool,
        dStructBull: Bool, dStructBear: Bool,
        hRsi: Double, hMacdHist: Double, hAdx: Double, hAdxBullish: Bool,
        hEmaCross: Int, hStackBull: Bool, hStackBear: Bool,
        hStructBull: Bool, hStructBear: Bool,
        atrPercent: Double, volScalar: Double, atrPercentile: Double,
        dailyScore: Int, fourHScore: Int,
        isCrypto: Bool
    ) -> Double? {
        let model = isCrypto ? cryptoModel : stockModel
        guard let model else { return nil }

        let input: [String: Double] = [
            "dRsi": dRsi,
            "dMacdHist": dMacdHist,
            "dAdx": dAdx,
            "dAdxBullish": dAdxBullish ? 1.0 : 0.0,
            "dEmaCross": Double(dEmaCross),
            "dStackBull": dStackBull ? 1.0 : 0.0,
            "dStackBear": dStackBear ? 1.0 : 0.0,
            "dStructBull": dStructBull ? 1.0 : 0.0,
            "dStructBear": dStructBear ? 1.0 : 0.0,
            "hRsi": hRsi,
            "hMacdHist": hMacdHist,
            "hAdx": hAdx,
            "hAdxBullish": hAdxBullish ? 1.0 : 0.0,
            "hEmaCross": Double(hEmaCross),
            "hStackBull": hStackBull ? 1.0 : 0.0,
            "hStackBear": hStackBear ? 1.0 : 0.0,
            "hStructBull": hStructBull ? 1.0 : 0.0,
            "hStructBear": hStructBear ? 1.0 : 0.0,
            "atrPercent": atrPercent,
            "volScalar": volScalar,
            "atrPercentile": atrPercentile,
            "dailyScore": Double(dailyScore),
            "fourHScore": Double(fourHScore)
        ]

        let nsInput = input.mapValues { NSNumber(value: $0) as NSObject }
        guard let provider = try? MLDictionaryFeatureProvider(dictionary: nsInput),
              let output = try? model.prediction(from: provider) else {
            #if DEBUG
            print("[MLScoring] Prediction failed")
            #endif
            return nil
        }

        // classProbability keys are Int64 (from XGBoost class_labels [0, 1])
        if let probs = output.featureValue(for: "classProbability")?.dictionaryValue,
           let winProb = probs[Int64(1)] as? Double {
            return winProb
        }
        #if DEBUG
        print("[MLScoring] Could not extract classProbability")
        #endif
        return nil
    }

    /// Convenience: predict from MLFeatures struct
    static func predict(features f: MLFeatures, dailyScore: Int, fourHScore: Int,
                        volScalar: Double, atrPercentile: Double) -> Double? {
        predict(
            dRsi: f.dRsi, dMacdHist: f.dMacdHist, dAdx: f.dAdx, dAdxBullish: f.dAdxBullish,
            dEmaCross: f.dEmaCross, dStackBull: f.dStackBull, dStackBear: f.dStackBear,
            dStructBull: f.dStructBull, dStructBear: f.dStructBear,
            hRsi: f.hRsi, hMacdHist: f.hMacdHist, hAdx: f.hAdx, hAdxBullish: f.hAdxBullish,
            hEmaCross: f.hEmaCross, hStackBull: f.hStackBull, hStackBear: f.hStackBear,
            hStructBull: f.hStructBull, hStructBear: f.hStructBear,
            atrPercent: f.atrPercent, volScalar: volScalar, atrPercentile: atrPercentile,
            dailyScore: dailyScore, fourHScore: fourHScore,
            isCrypto: f.isCrypto
        )
    }
}
