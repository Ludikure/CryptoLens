import Foundation

// MARK: - Metrics & Result

struct OptimizerMetrics: Identifiable {
    var id: String { symbol }
    let symbol: String
    let opportunityRate: Double   // % of directional labels where price moved >1% in direction
    let accuracy24H: Double       // directional accuracy at 24H
    let totalBars: Int
    let directionalBars: Int
}

struct OptimizationResult: Identifiable {
    let id = UUID()
    let params: ScoringParams
    let trainMetrics: [OptimizerMetrics]
    let validMetrics: [OptimizerMetrics]
    let worstTrainOpp: Double
    let worstValidOpp: Double
    let avgTrainOpp: Double
    let avgValidOpp: Double
    let gap: Double               // train - valid opportunity rate
}

// MARK: - Engine

@MainActor
class OptimizerEngine: ObservableObject {
    @Published var isRunning = false
    @Published var progress: Double = 0
    @Published var statusMessage = ""
    @Published var results: [OptimizationResult] = []
    @Published var bestResult: OptimizationResult?

    private let binance = BinanceService()
    private let yahoo = YahooFinanceService()

    // MARK: - Public API

    func run(symbols: [String], market: Market, startDate: Date, endDate: Date) async {
        isRunning = true
        progress = 0
        results = []
        bestResult = nil
        statusMessage = "Building snapshots..."

        do {
            // Build snapshots per symbol
            var allSnapshots = [String: [ScoringSnapshot]]()
            for (idx, symbol) in symbols.enumerated() {
                statusMessage = "Building snapshots for \(symbol) (\(idx + 1)/\(symbols.count))..."
                let snapshots = try await buildSnapshotsForSymbol(
                    symbol: symbol, market: market, startDate: startDate, endDate: endDate)
                if snapshots.count >= 50 {
                    allSnapshots[symbol] = snapshots
                }
                progress = Double(idx + 1) / Double(symbols.count) * 0.3
                await Task.yield()
            }

            guard !allSnapshots.isEmpty else {
                statusMessage = "No symbols with sufficient data"
                isRunning = false
                return
            }

            // Split train/valid (67/33)
            var trainSets = [String: [ScoringSnapshot]]()
            var validSets = [String: [ScoringSnapshot]]()
            for (symbol, snaps) in allSnapshots {
                let splitIdx = Int(Double(snaps.count) * 0.67)
                trainSets[symbol] = Array(snaps[..<splitIdx])
                validSets[symbol] = Array(snaps[splitIdx...])
            }

            // Stage 1: Structural sweep (81 combos)
            statusMessage = "Stage 1: Structural sweep..."
            let structuralCombos = generateStructuralCombos()
            var stage1Results = [OptimizationResult]()

            for (idx, params) in structuralCombos.enumerated() {
                let trainMetrics = evaluatePerAsset(snapshots: trainSets, params: params)
                let validMetrics = evaluatePerAsset(snapshots: validSets, params: params)
                let result = makeResult(params: params, train: trainMetrics, valid: validMetrics)
                stage1Results.append(result)
                if idx % 10 == 0 {
                    progress = 0.3 + Double(idx) / Double(structuralCombos.count) * 0.25
                    await Task.yield()
                }
            }

            // Pick top 5 by worst-asset validation opportunity
            let top5Structural = stage1Results
                .filter { $0.gap < 15 }
                .sorted { $0.worstValidOpp > $1.worstValidOpp }
                .prefix(5)

            guard let bestStructural = top5Structural.first else {
                statusMessage = "No viable structural combos found"
                isRunning = false
                return
            }

            // Stage 2: Threshold sweep (45 combos per base)
            statusMessage = "Stage 2: Threshold sweep..."
            var stage2Results = [OptimizationResult]()
            let thresholdCombos = generateThresholdCombos(base: bestStructural.params)

            for (idx, params) in thresholdCombos.enumerated() {
                let trainMetrics = evaluatePerAsset(snapshots: trainSets, params: params)
                let validMetrics = evaluatePerAsset(snapshots: validSets, params: params)
                let result = makeResult(params: params, train: trainMetrics, valid: validMetrics)
                stage2Results.append(result)
                if idx % 10 == 0 {
                    progress = 0.55 + Double(idx) / Double(thresholdCombos.count) * 0.2
                    await Task.yield()
                }
            }

            let bestThreshold = stage2Results
                .filter { $0.gap < 15 }
                .sorted { $0.worstValidOpp > $1.worstValidOpp }
                .first ?? makeResult(params: bestStructural.params,
                                      train: evaluatePerAsset(snapshots: trainSets, params: bestStructural.params),
                                      valid: evaluatePerAsset(snapshots: validSets, params: bestStructural.params))

            // Stage 3: Momentum sweep (81 combos)
            statusMessage = "Stage 3: Momentum sweep..."
            var stage3Results = [OptimizationResult]()
            let momentumCombos = generateMomentumCombos(base: bestThreshold.params)

            for (idx, params) in momentumCombos.enumerated() {
                let trainMetrics = evaluatePerAsset(snapshots: trainSets, params: params)
                let validMetrics = evaluatePerAsset(snapshots: validSets, params: params)
                let result = makeResult(params: params, train: trainMetrics, valid: validMetrics)
                stage3Results.append(result)
                if idx % 10 == 0 {
                    progress = 0.75 + Double(idx) / Double(momentumCombos.count) * 0.2
                    await Task.yield()
                }
            }

            // Final ranking across all stages
            let allResults = (stage1Results + stage2Results + stage3Results)
                .filter { $0.gap < 15 }
                .sorted { $0.worstValidOpp > $1.worstValidOpp }

            results = Array(allResults.prefix(10))
            bestResult = results.first
            progress = 1.0
            statusMessage = "Complete: \(allResults.count) combos evaluated, \(allSnapshots.count) assets"

        } catch {
            statusMessage = "Error: \(error.localizedDescription)"
        }

        isRunning = false
    }

    func applyBest(for market: Market) {
        bestResult?.params.save(for: market)
        statusMessage = "Applied to \(market == .crypto ? "crypto" : "stock"): \(bestResult?.params.label ?? "none")"
    }

    // MARK: - Combo Generators

    private func generateStructuralCombos() -> [ScoringParams] {
        var combos = [ScoringParams]()
        for pp in [1, 2, 3] {
            for st in [1, 2, 3] {
                for sc in [0, 1, 2] {
                    for es in [0, 1] {
                        var p = ScoringParams()
                        p.pricePositionWeight = pp
                        p.structureWeight = st
                        p.stackConfirmWeight = sc
                        p.emaSlopeWeight = es
                        combos.append(p)
                    }
                }
            }
        }
        // 3 * 3 * 3 * 2 = 54 (close enough, some overlap with defaults adds more)
        return combos
    }

    private func generateThresholdCombos(base: ScoringParams) -> [ScoringParams] {
        var combos = [ScoringParams]()
        for dDir in [3, 4, 5] {
            for dDelta in [2, 3, 4] {
                for fDir in [2, 3, 4] {
                    for fDelta in [2, 3, 4] {
                        // Skip clearly dominated combos
                        let dStrong = dDir + dDelta
                        let fStrong = fDir + fDelta
                        if dStrong > 12 || fStrong > 10 { continue }
                        var p = base
                        p.dailyDirectionalThreshold = dDir
                        p.dailyStrongThreshold = dStrong
                        p.fourHDirectionalThreshold = fDir
                        p.fourHStrongThreshold = fStrong
                        combos.append(p)
                    }
                }
            }
        }
        return combos
    }

    private func generateMomentumCombos(base: ScoringParams) -> [ScoringParams] {
        var combos = [ScoringParams]()
        for rsi in [1, 2, 3] {
            for macd in [1, 2, 3] {
                for vwap in [0, 1] {
                    for stoch in [0, 1] {
                        for div in [0, 1] {
                            var p = base
                            p.rsiWeight = rsi
                            p.macdMaxWeight = macd
                            p.vwapWeight = vwap
                            p.stochWeight = stoch
                            p.divergenceWeight = div
                            combos.append(p)
                        }
                    }
                }
            }
        }
        // 3 * 3 * 2 * 2 * 2 = 72
        return combos
    }

    // MARK: - Snapshot Building

    private func buildSnapshotsForSymbol(symbol: String, market: Market,
                                          startDate: Date, endDate: Date) async throws -> [ScoringSnapshot] {
        // Check cache first
        if let cached = SnapshotCache.load(symbol: symbol, timeframe: "daily_4h") {
            let filtered = cached.filter { $0.timestamp >= startDate && $0.timestamp <= endDate }
            if filtered.count >= 50 { return filtered }
        }

        let isCrypto = market == .crypto
        let warmupDays: TimeInterval = 220 * 86400
        let fetchStart = startDate.addingTimeInterval(-warmupDays)

        let dailyCandles: [Candle]
        let fourHCandles: [Candle]

        if isCrypto {
            dailyCandles = try await CandleCache.loadOrFetch(
                symbol: symbol, interval: "1d", startDate: fetchStart, endDate: endDate,
                fetcher: { s, i, sd, ed in try await self.binance.fetchHistoricalCandles(symbol: s, interval: i, startDate: sd, endDate: ed) })
            fourHCandles = try await CandleCache.loadOrFetch(
                symbol: symbol, interval: "4h", startDate: fetchStart, endDate: endDate,
                fetcher: { s, i, sd, ed in try await self.binance.fetchHistoricalCandles(symbol: s, interval: i, startDate: sd, endDate: ed) })
        } else {
            dailyCandles = try await CandleCache.loadOrFetch(
                symbol: symbol, interval: "1d", startDate: fetchStart, endDate: endDate,
                fetcher: { s, i, sd, ed in try await self.yahoo.fetchHistoricalCandles(symbol: s, interval: i, startDate: sd, endDate: ed) })
            let hourly = try await CandleCache.loadOrFetch(
                symbol: symbol, interval: "1h", startDate: fetchStart, endDate: endDate,
                fetcher: { s, i, sd, ed in try await self.yahoo.fetchHistoricalCandles(symbol: s, interval: i, startDate: sd, endDate: ed) })
            fourHCandles = CandleAggregator.aggregate1HTo4H(hourly)
        }

        guard dailyCandles.count >= 250, fourHCandles.count >= 250 else {
            return []
        }

        // Walk-forward: evaluate at each 4H bar
        let evalStartIndex = fourHCandles.firstIndex { $0.time >= startDate } ?? 200
        var snapshots = [ScoringSnapshot]()
        var dailyIdx = 0

        for i in evalStartIndex..<(fourHCandles.count - 6) {
            let evalTime = fourHCandles[i].time

            while dailyIdx < dailyCandles.count && dailyCandles[dailyIdx].time <= evalTime { dailyIdx += 1 }
            let dailySlice = Array(dailyCandles[..<dailyIdx])
            let fourHSlice = Array(fourHCandles[...i])

            guard dailySlice.count >= 210, fourHSlice.count >= 210 else { continue }

            // Compute indicators for daily
            let dailyResult = IndicatorEngine.computeAll(
                candles: Array(dailySlice.suffix(300)), timeframe: "1d", label: "Daily (Trend)", market: market)

            // Forward prices
            let price = fourHCandles[i].close
            let forward6 = Array(fourHCandles[(i+1)...min(i+6, fourHCandles.count - 1)])
            let maxHigh = forward6.map(\.high).max()
            let maxLow = forward6.map(\.low).min()
            let priceAfter4H: Double? = (i + 1 < fourHCandles.count) ? fourHCandles[i + 1].close : nil
            let priceAfter24H: Double? = (i + 6 < fourHCandles.count) ? fourHCandles[i + 6].close : nil

            let snapshot = extractSnapshot(from: dailyResult, candles: Array(dailySlice.suffix(300)),
                                            price: price, time: evalTime, isCrypto: isCrypto,
                                            priceAfter4H: priceAfter4H, priceAfter24H: priceAfter24H,
                                            forwardHigh24H: maxHigh, forwardLow24H: maxLow)
            snapshots.append(snapshot)
        }

        // Cache snapshots
        SnapshotCache.save(snapshots, symbol: symbol, timeframe: "daily_4h")
        return snapshots
    }

    private func extractSnapshot(from result: IndicatorResult, candles: [Candle],
                                  price: Double, time: Date, isCrypto: Bool,
                                  priceAfter4H: Double?, priceAfter24H: Double?,
                                  forwardHigh24H: Double?, forwardLow24H: Double?) -> ScoringSnapshot {
        let ema20List = MovingAverages.computeEMA(values: candles.map(\.close), period: 20)
        let ema20Rising: Bool
        if ema20List.count >= 6 {
            ema20Rising = ema20List[ema20List.count - 1] > ema20List[ema20List.count - 6]
        } else {
            ema20Rising = false
        }

        var emaCrossCount = 0
        if let e20 = result.ema20, price > e20 { emaCrossCount += 1 }
        if let e50 = result.ema50, price > e50 { emaCrossCount += 1 }
        if let e200 = result.ema200, price > e200 { emaCrossCount += 1 }

        let stackBullish: Bool
        let stackBearish: Bool
        if let e20 = result.ema20, let e50 = result.ema50, let e200 = result.ema200 {
            stackBullish = e20 > e50 && e50 > e200
            stackBearish = e20 < e50 && e50 < e200
        } else {
            stackBullish = false
            stackBearish = false
        }

        let structureBullish = result.marketStructure?.label.contains("bullish") ?? false
        let structureBearish = result.marketStructure?.label.contains("bearish") ?? false

        let macdHistAboveDeadZone: Bool
        if let m = result.macd, let atr = result.atr {
            let deadZone = atr.atr * 0.001 * (result.volScalar ?? 1.0)
            macdHistAboveDeadZone = abs(m.histogram) > deadZone
        } else {
            macdHistAboveDeadZone = false
        }

        // Last 3 candle analysis
        let last3 = Array(candles.suffix(3))
        let last3Green = last3.allSatisfy { $0.close >= $0.open }
        let last3Red = last3.allSatisfy { $0.close < $0.open }
        let last3VolIncreasing = last3.count == 3 &&
            last3[2].volume >= last3[1].volume && last3[1].volume >= last3[0].volume

        return ScoringSnapshot(
            timestamp: time,
            price: price,
            timeframe: result.timeframe,
            isCrypto: isCrypto,
            ema20: result.ema20,
            ema50: result.ema50,
            ema200: result.ema200,
            emaCrossCount: emaCrossCount,
            ema20Rising: ema20Rising,
            stackBullish: stackBullish,
            stackBearish: stackBearish,
            structureBullish: structureBullish,
            structureBearish: structureBearish,
            adxValue: result.adx?.adx ?? 0,
            adxBullish: result.adx?.direction == "Bullish",
            rsi: result.rsi,
            macdHistogram: result.macd?.histogram ?? 0,
            macdCrossover: result.macd?.crossover,
            macdHistAboveDeadZone: macdHistAboveDeadZone,
            stochK: result.stochRSI?.k,
            stochCrossover: result.stochRSI?.crossover,
            aboveVwap: result.vwap.map { price > $0.vwap } ?? false,
            divergence: result.divergence,
            last3Green: last3Green,
            last3Red: last3Red,
            last3VolIncreasing: last3VolIncreasing,
            currentRSI: result.rsi,
            crossAssetSignal: 0,
            volScalar: result.volScalar ?? 1.0,
            obvRising: result.obv?.trend == "Rising",
            adLineAccumulation: result.adLine?.trend == "Accumulation",
            priceAfter4H: priceAfter4H,
            priceAfter24H: priceAfter24H,
            forwardHigh24H: forwardHigh24H,
            forwardLow24H: forwardLow24H
        )
    }

    // MARK: - Evaluation

    private func evaluatePerAsset(snapshots: [String: [ScoringSnapshot]], params: ScoringParams) -> [OptimizerMetrics] {
        snapshots.map { symbol, snaps in
            var directional = 0
            var correct24H = 0
            var opportunities = 0

            for snap in snaps {
                let (_, bias) = ScoringFunction.score(snapshot: snap, params: params)
                let isBullish = bias.contains("Bullish")
                let isBearish = bias.contains("Bearish")

                guard isBullish || isBearish else { continue }
                directional += 1

                // Direction correctness at 24H
                if let future = snap.priceAfter24H {
                    if isBullish && future > snap.price { correct24H += 1 }
                    if isBearish && future < snap.price { correct24H += 1 }
                }

                // Opportunity: did price move >1% in labeled direction within 24H?
                if isBullish, let high = snap.forwardHigh24H, snap.price > 0 {
                    if (high - snap.price) / snap.price * 100 > 1.0 { opportunities += 1 }
                }
                if isBearish, let low = snap.forwardLow24H, snap.price > 0 {
                    if (snap.price - low) / snap.price * 100 > 1.0 { opportunities += 1 }
                }
            }

            return OptimizerMetrics(
                symbol: symbol,
                opportunityRate: directional > 0 ? Double(opportunities) / Double(directional) * 100 : 0,
                accuracy24H: directional > 0 ? Double(correct24H) / Double(directional) * 100 : 0,
                totalBars: snaps.count,
                directionalBars: directional
            )
        }
    }

    private func makeResult(params: ScoringParams, train: [OptimizerMetrics], valid: [OptimizerMetrics]) -> OptimizationResult {
        let worstTrain = train.map(\.opportunityRate).min() ?? 0
        let worstValid = valid.map(\.opportunityRate).min() ?? 0
        let avgTrain = train.isEmpty ? 0 : train.map(\.opportunityRate).reduce(0, +) / Double(train.count)
        let avgValid = valid.isEmpty ? 0 : valid.map(\.opportunityRate).reduce(0, +) / Double(valid.count)

        return OptimizationResult(
            params: params,
            trainMetrics: train,
            validMetrics: valid,
            worstTrainOpp: worstTrain,
            worstValidOpp: worstValid,
            avgTrainOpp: avgTrain,
            avgValidOpp: avgValid,
            gap: abs(avgTrain - avgValid)
        )
    }
}
