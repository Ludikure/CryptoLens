import Foundation

/// ML scoring using native XGBoost tree evaluation — same JSON format as the worker.
/// Reads ml-model-{crypto,stock}.json (trees + embedded calibration).
/// Replaces CoreML to eliminate conversion loss and ensure iOS/worker parity.
enum MLScoring {
    private static let cryptoModel = loadModel("ml-model-crypto")
    private static let stockModel  = loadModel("ml-model-stock")

    private struct TreeModel {
        let trees: [TreeNode]
        let baseScore: Double
        let calibrationX: [Double]
        let calibrationY: [Double]
        let cap: Double
    }

    private struct TreeNode {
        let nodeid: Int
        let split: String?
        let splitCondition: Double?
        let yes: Int?
        let no: Int?
        let leaf: Double?
        let children: [TreeNode]
    }

    private static func loadModel(_ name: String) -> TreeModel? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let treesRaw = json["trees"] as? [[String: Any]]
        else {
            #if DEBUG
            print("[MLScoring] \(name).json not found in bundle")
            #endif
            return nil
        }
        let baseScore = json["base_score"] as? Double ?? 0.5
        let cal = json["calibration"] as? [String: Any]
        let calX = cal?["x"] as? [Double] ?? []
        let calY = cal?["y"] as? [Double] ?? []
        let cap = cal?["cap"] as? Double ?? 0.85
        let trees = treesRaw.map { parseNode($0) }
        return TreeModel(trees: trees, baseScore: baseScore,
                         calibrationX: calX, calibrationY: calY, cap: cap)
    }

    private static func parseNode(_ dict: [String: Any]) -> TreeNode {
        let children = (dict["children"] as? [[String: Any]])?.map { parseNode($0) } ?? []
        return TreeNode(
            nodeid: dict["nodeid"] as? Int ?? 0,
            split: dict["split"] as? String,
            splitCondition: dict["split_condition"] as? Double,
            yes: dict["yes"] as? Int,
            no: dict["no"] as? Int,
            leaf: dict["leaf"] as? Double,
            children: children
        )
    }

    private static func evaluateTree(_ node: TreeNode, _ input: [String: Double]) -> Double {
        if let leaf = node.leaf { return leaf }
        guard let split = node.split, let cond = node.splitCondition else { return 0 }
        let val = input[split] ?? 0
        let goLeft = val < cond
        let targetId = goLeft ? node.yes : node.no
        guard let targetId, let next = node.children.first(where: { $0.nodeid == targetId }) else { return 0 }
        return evaluateTree(next, input)
    }

    private static func sigmoid(_ x: Double) -> Double { 1.0 / (1.0 + exp(-x)) }

    private static func calibrate(_ rawProb: Double, _ model: TreeModel) -> Double {
        let x = model.calibrationX, y = model.calibrationY
        guard x.count >= 2, x.count == y.count else { return rawProb }
        if rawProb <= x[0] { return y[0] }
        if rawProb >= x[x.count - 1] { return y[y.count - 1] }
        var lo = 0, hi = x.count - 1
        while lo < hi - 1 {
            let mid = (lo + hi) / 2
            if x[mid] <= rawProb { lo = mid } else { hi = mid }
        }
        let t = (rawProb - x[lo]) / (x[hi] - x[lo])
        return max(0, min(model.cap, y[lo] + t * (y[hi] - y[lo])))
    }

    static func predict(features f: MLFeatures) -> Double? {
        let model = f.isCrypto ? cryptoModel : stockModel
        guard let model else { return nil }
        let input = buildFeatureDict(f)
        let baseLogit = log(model.baseScore / (1 - model.baseScore))
        var sum = baseLogit
        for tree in model.trees { sum += evaluateTree(tree, input) }
        guard sum.isFinite else { return 0.5 }
        return calibrate(sigmoid(sum), model)
    }

    private static func buildFeatureDict(_ f: MLFeatures) -> [String: Double] {
        [
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
            "atrPercent": f.atrPercent, "atrPercentile": f.atrPercentile,
            "tfAlignment": Double(f.tfAlignment), "momentumAlignment": Double(f.momentumAlignment),
            "structureAlignment": Double(f.structureAlignment),
            "dayOfWeek": Double(f.dayOfWeek),
            "barsSinceRegimeChange": Double(f.barsSinceRegimeChange),
            "regimeCode": Double(f.regimeCode),
            "dRsiDelta": f.dRsiDelta, "dAdxDelta": f.dAdxDelta,
            "hRsiDelta": f.hRsiDelta, "hAdxDelta": f.hAdxDelta,
            "hMacdHistDelta": f.hMacdHistDelta,
            "fearGreedIndex": f.fearGreedIndex, "fearGreedZone": Double(f.fearGreedZone),
            "ethBtcRatio": f.ethBtcRatio, "ethBtcDelta6": f.ethBtcDelta6,
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
            "earningsProximity": f.earningsProximity,
            "shortVolumeRatio": f.shortVolumeRatio, "shortVolumeZScore": f.shortVolumeZScore,
            "oiPriceInteraction": f.oiPriceInteraction,
            "fundingSlope": f.fundingSlope, "bodyWickRatio": f.bodyWickRatio,
        ]
    }
}
