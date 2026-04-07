import Foundation

@MainActor
class BacktestEngine: ObservableObject {
    @Published var isRunning = false
    @Published var progress: Double = 0
    @Published var statusMessage = ""
    @Published var result: BacktestSummary?
    @Published var dataPoints: [BacktestDataPoint] = []

    private let binance = BinanceService()

    func run(symbol: String, startDate: Date, endDate: Date) async {
        isRunning = true
        progress = 0
        statusMessage = "Fetching historical data..."
        dataPoints = []

        do {
            let warmupDays: TimeInterval = 220 * 86400
            let fetchStart = startDate.addingTimeInterval(-warmupDays)

            statusMessage = "Fetching daily candles..."
            let dailyCandles = try await binance.fetchHistoricalCandles(
                symbol: symbol, interval: "1d", startDate: fetchStart, endDate: endDate)

            statusMessage = "Fetching 4H candles..."
            let fourHCandles = try await binance.fetchHistoricalCandles(
                symbol: symbol, interval: "4h", startDate: fetchStart, endDate: endDate)

            statusMessage = "Fetching 1H candles..."
            let oneHCandles = try await binance.fetchHistoricalCandles(
                symbol: symbol, interval: "1h", startDate: fetchStart, endDate: endDate)

            guard dailyCandles.count >= 250, fourHCandles.count >= 250 else {
                statusMessage = "Insufficient data: D=\(dailyCandles.count), 4H=\(fourHCandles.count)"
                isRunning = false
                return
            }

            statusMessage = "Running walk-forward..."

            let evalStartIndex = fourHCandles.firstIndex { $0.time >= startDate } ?? 200
            let totalBars = fourHCandles.count - evalStartIndex - 6
            var points = [BacktestDataPoint]()

            #if DEBUG
            print("[Backtest] Data: D=\(dailyCandles.count), 4H=\(fourHCandles.count), 1H=\(oneHCandles.count)")
            #endif

            // Precompute index boundaries — O(n) total instead of O(n×m) filter per iteration
            var dailyIdx = 0, oneHIdx = 0

            for i in evalStartIndex..<(fourHCandles.count - 6) {
                let evalTime = fourHCandles[i].time

                // Advance indices to current eval time (monotonically increasing)
                while dailyIdx < dailyCandles.count && dailyCandles[dailyIdx].time <= evalTime { dailyIdx += 1 }
                while oneHIdx < oneHCandles.count && oneHCandles[oneHIdx].time <= evalTime { oneHIdx += 1 }

                let dailySlice = Array(dailyCandles[..<dailyIdx])
                let fourHSlice = Array(fourHCandles[...i])
                let oneHSlice = Array(oneHCandles[..<oneHIdx])

                guard dailySlice.count >= 210, fourHSlice.count >= 210, oneHSlice.count >= 30 else { continue }

                let dailyResult = IndicatorEngine.computeAll(
                    candles: Array(dailySlice.suffix(300)), timeframe: "1d", label: "Daily (Trend)", market: .crypto)
                let fourHResult = IndicatorEngine.computeAll(
                    candles: Array(fourHSlice.suffix(300)), timeframe: "4h", label: "4H (Bias)", market: .crypto)
                let oneHResult = IndicatorEngine.computeAll(
                    candles: Array(oneHSlice.suffix(300)), timeframe: "1h", label: "1H (Entry)", market: .crypto)

                let dBearish = dailyResult.bias.contains("Bearish")
                let dBullish = dailyResult.bias.contains("Bullish")
                let hBearish = fourHResult.bias.contains("Bearish")
                let hBullish = fourHResult.bias.contains("Bullish")

                let alignment: String
                if dBearish && hBearish { alignment = "aligned_bearish" }
                else if dBullish && hBullish { alignment = "aligned_bullish" }
                else if (dBearish && hBullish) || (dBullish && hBearish) { alignment = "conflict" }
                else { alignment = "neutral" }

                let adxDaily = dailyResult.adx?.adx ?? 0
                var maAlign = "tangled"
                if let e20 = dailyResult.ema20, let e50 = dailyResult.ema50, let e200 = dailyResult.ema200 {
                    if e20 > e50 && e50 > e200 { maAlign = "bullish_stacked" }
                    else if e20 < e50 && e50 < e200 { maAlign = "bearish_stacked" }
                }
                let regime: String
                if adxDaily > 25 && maAlign != "tangled" { regime = "TRENDING" }
                else if adxDaily < 20 { regime = "RANGING" }
                else { regime = "TRANSITIONING" }

                let price = fourHCandles[i].close
                let forward6 = Array(fourHCandles[(i+1)...(i+6)])
                let maxHigh = forward6.map(\.high).max() ?? price
                let maxLow = forward6.map(\.low).min() ?? price

                let maxFav: Double
                let maxAdv: Double
                if alignment.contains("bearish") {
                    maxFav = price - maxLow; maxAdv = maxHigh - price
                } else if alignment.contains("bullish") {
                    maxFav = maxHigh - price; maxAdv = price - maxLow
                } else {
                    maxFav = max(maxHigh - price, price - maxLow); maxAdv = 0
                }

                let point = BacktestDataPoint(
                    timestamp: evalTime, price: price,
                    dailyScore: dailyResult.biasScore, dailyBias: dailyResult.bias,
                    fourHScore: fourHResult.biasScore, fourHBias: fourHResult.bias,
                    oneHScore: oneHResult.biasScore, oneHBias: oneHResult.bias,
                    biasAlignment: alignment, regime: regime,
                    emaRegime: {
                        if let e20 = dailyResult.ema20, let e50 = dailyResult.ema50, let e200 = dailyResult.ema200 {
                            if e20 > e50 && e50 > e200 { return "bullish" }
                            if e20 < e50 && e50 < e200 { return "bearish" }
                        }; return "mixed"
                    }(),
                    volScalar: dailyResult.volScalar ?? 1.0,
                    atrPercentile: dailyResult.atrPercentile ?? 50,
                    priceAfter4H: fourHCandles[i + 1].close,
                    priceAfter3x4H: fourHCandles[i + 3].close,
                    priceAfter6x4H: fourHCandles[i + 6].close,
                    maxFavorable24H: maxFav, maxAdverse24H: maxAdv
                )
                points.append(point)

                let progressIdx = i - evalStartIndex
                if progressIdx % 10 == 0 {
                    progress = Double(progressIdx) / Double(max(1, totalBars))
                    statusMessage = "Evaluating bar \(progressIdx)/\(totalBars)..."
                    await Task.yield()
                }
            }

            dataPoints = points
            statusMessage = "Computing statistics..."
            result = computeSummary(points: points, symbol: symbol, startDate: startDate, endDate: endDate)
            statusMessage = "Complete: \(points.count) bars evaluated"
        } catch {
            statusMessage = "Error: \(error.localizedDescription)"
        }
        isRunning = false
    }

    private func computeSummary(points: [BacktestDataPoint], symbol: String,
                                 startDate: Date, endDate: Date) -> BacktestSummary {
        let directional = points.filter { $0.biasAlignment.contains("bearish") || $0.biasAlignment.contains("bullish") }
        let flats = points.filter { $0.biasAlignment == "conflict" || $0.biasAlignment == "neutral" }

        let correct4H = directional.filter { $0.directionCorrect4H == true }.count
        let correct24H = directional.filter { $0.directionCorrect24H == true }.count

        let bearish = directional.filter { $0.biasAlignment.contains("bearish") }
        let bullish = directional.filter { $0.biasAlignment.contains("bullish") }
        let bearishCorrect = bearish.filter { $0.directionCorrect24H == true }.count
        let bullishCorrect = bullish.filter { $0.directionCorrect24H == true }.count

        let strong = directional.filter { abs($0.dailyScore) >= 7 || abs($0.fourHScore) >= 6 }
        let moderate = directional.filter { abs($0.dailyScore) >= 4 && abs($0.dailyScore) < 7 }
        let weak = directional.filter { abs($0.dailyScore) < 4 }

        let trending = directional.filter { $0.regime == "TRENDING" }
        let ranging = directional.filter { $0.regime == "RANGING" }
        let transitioning = directional.filter { $0.regime == "TRANSITIONING" }

        let staticCorrect = directional.filter { pt in
            let sDaily = staticLabel(score: pt.dailyScore, dirThreshold: 4, strongThreshold: 7)
            let sFourH = staticLabel(score: pt.fourHScore, dirThreshold: 3, strongThreshold: 6)
            let sAlign = alignmentFrom(daily: sDaily, fourH: sFourH)
            guard let future = pt.priceAfter6x4H else { return false }
            if sAlign.contains("bearish") { return future < pt.price }
            if sAlign.contains("bullish") { return future > pt.price }
            return false
        }.count

        let flatMoves = flats.compactMap { pt -> Double? in
            guard let future = pt.priceAfter6x4H else { return nil }
            return abs(future - pt.price) / pt.price * 100
        }

        func acc(_ items: [BacktestDataPoint]) -> Double {
            let c = items.filter { $0.directionCorrect24H == true }.count
            return items.isEmpty ? 0 : Double(c) / Double(items.count) * 100
        }

        return BacktestSummary(
            symbol: symbol, startDate: startDate, endDate: endDate,
            totalBars: points.count, evaluatedBars: directional.count,
            accuracy4H: directional.isEmpty ? 0 : Double(correct4H) / Double(directional.count) * 100,
            accuracy24H: directional.isEmpty ? 0 : Double(correct24H) / Double(directional.count) * 100,
            bearishAccuracy: acc(bearish), bullishAccuracy: acc(bullish),
            strongAccuracy: acc(strong), moderateAccuracy: acc(moderate), weakAccuracy: acc(weak),
            trendingAccuracy: acc(trending), rangingAccuracy: acc(ranging), transitioningAccuracy: acc(transitioning),
            adaptiveAccuracy: directional.isEmpty ? 0 : Double(correct24H) / Double(directional.count) * 100,
            staticAccuracy: directional.isEmpty ? 0 : Double(staticCorrect) / Double(directional.count) * 100,
            totalFlats: flats.count,
            correctFlats: flatMoves.filter { $0 < 0.5 }.count,
            falseFlats: flatMoves.filter { $0 > 1.5 }.count,
            flatAccuracy: flatMoves.isEmpty ? 0 : Double(flatMoves.filter { $0 < 0.5 }.count) / Double(flatMoves.count) * 100,
            thresholdSweep: runThresholdSweep(points: points),
            scoreDistribution: computeScoreDistribution(points: points)
        )
    }

    private func runThresholdSweep(points: [BacktestDataPoint]) -> [ThresholdResult] {
        var results = [ThresholdResult]()
        for dir in 2...7 {
            for delta in 2...5 {
                let strong = dir + delta
                var total = 0, correct = 0
                for pt in points {
                    let dLabel = staticLabel(score: pt.dailyScore, dirThreshold: dir, strongThreshold: strong)
                    let hLabel = staticLabel(score: pt.fourHScore, dirThreshold: 3, strongThreshold: 6)
                    let align = alignmentFrom(daily: dLabel, fourH: hLabel)
                    if align.contains("bearish") || align.contains("bullish") {
                        total += 1
                        if let future = pt.priceAfter6x4H {
                            if align.contains("bearish") && future < pt.price { correct += 1 }
                            if align.contains("bullish") && future > pt.price { correct += 1 }
                        }
                    }
                }
                results.append(ThresholdResult(
                    directionalThreshold: dir, strongThreshold: strong,
                    accuracy4H: 0, accuracy24H: total > 0 ? Double(correct) / Double(total) * 100 : 0,
                    totalDirectional: total,
                    tradeFrequency: points.isEmpty ? 0 : Double(total) / Double(points.count) * 100
                ))
            }
        }
        return results.sorted { $0.accuracy24H > $1.accuracy24H }
    }

    private func computeScoreDistribution(points: [BacktestDataPoint]) -> [ScoreBucket] {
        // Group by Daily score
        var groups = [Int: [BacktestDataPoint]]()
        for pt in points {
            groups[pt.dailyScore, default: []].append(pt)
        }

        return groups.map { score, pts in
            let directional = pts.filter { pt in
                // For this score, determine direction
                if score > 0 { return true }   // positive = would be bullish
                if score < 0 { return true }   // negative = would be bearish
                return false                   // 0 = neutral
            }

            let correct = directional.filter { pt in
                guard let future = pt.priceAfter6x4H else { return false }
                if score > 0 { return future > pt.price }  // bullish score, price went up
                if score < 0 { return future < pt.price }  // bearish score, price went down
                return false
            }.count

            let avgMove = pts.compactMap { pt -> Double? in
                guard let future = pt.priceAfter6x4H else { return nil }
                let move = (future - pt.price) / pt.price * 100
                // Return signed move relative to score direction
                return score < 0 ? -move : move  // positive = moved in expected direction
            }
            let avg = avgMove.isEmpty ? 0 : avgMove.reduce(0, +) / Double(avgMove.count)

            return ScoreBucket(
                score: score,
                count: pts.count,
                correct24H: correct,
                accuracy: directional.isEmpty ? 0 : Double(correct) / Double(directional.count) * 100,
                avgMove: avg
            )
        }.sorted { $0.score < $1.score }
    }

    private func staticLabel(score: Int, dirThreshold: Int, strongThreshold: Int) -> String {
        if score >= strongThreshold { return "Strong Bullish" }
        if score >= dirThreshold { return "Bullish" }
        if score <= -strongThreshold { return "Strong Bearish" }
        if score <= -dirThreshold { return "Bearish" }
        return "Neutral"
    }

    private func alignmentFrom(daily: String, fourH: String) -> String {
        let dB = daily.contains("Bearish"), dU = daily.contains("Bullish")
        let hB = fourH.contains("Bearish"), hU = fourH.contains("Bullish")
        if dB && hB { return "aligned_bearish" }
        if dU && hU { return "aligned_bullish" }
        if (dB && hU) || (dU && hB) { return "conflict" }
        return "neutral"
    }
}
