import Foundation

@MainActor
class BacktestEngine: ObservableObject {
    @Published var isRunning = false
    @Published var progress: Double = 0
    @Published var statusMessage = ""
    @Published var result: BacktestSummary?
    @Published var dataPoints: [BacktestDataPoint] = []

    private let binance = BinanceService()
    private let yahoo = YahooFinanceService()
    private let tiingo = TiingoProvider()
    private let alphaVantage = AlphaVantageProvider()

    func run(symbol: String, startDate: Date, endDate: Date) async {
        isRunning = true
        progress = 0
        statusMessage = "Fetching historical data..."
        dataPoints = []

        let isCrypto = symbol.hasSuffix("USDT") || symbol.hasSuffix("BTC") || symbol.hasSuffix("BUSD")
        let market: Market = isCrypto ? .crypto : .stock

        do {
            let warmupDays: TimeInterval = 220 * 86400
            let fetchStart = startDate.addingTimeInterval(-warmupDays)

            let dailyCandles: [Candle]
            let fourHCandles: [Candle]
            let oneHCandles: [Candle]

            if isCrypto {
                statusMessage = "Fetching daily candles (Binance)..."
                dailyCandles = try await binance.fetchHistoricalCandles(
                    symbol: symbol, interval: "1d", startDate: fetchStart, endDate: endDate)
                statusMessage = "Fetching 4H candles..."
                fourHCandles = try await binance.fetchHistoricalCandles(
                    symbol: symbol, interval: "4h", startDate: fetchStart, endDate: endDate)
                statusMessage = "Fetching 1H candles..."
                oneHCandles = try await binance.fetchHistoricalCandles(
                    symbol: symbol, interval: "1h", startDate: fetchStart, endDate: endDate)
            } else {
                statusMessage = "Fetching daily candles (Yahoo)..."
                dailyCandles = try await yahoo.fetchHistoricalCandles(
                    symbol: symbol, interval: "1d", startDate: fetchStart, endDate: endDate)
                // Stitch Yahoo (2yr) + Alpha Vantage (older) for max history
                statusMessage = "Fetching 1H candles (stitched)..."
                let hourly = try await CandleCache.loadOrFetchStitched(
                    symbol: symbol, startDate: fetchStart, endDate: endDate,
                    yahoo: yahoo, alphaVantage: alphaVantage)
                fourHCandles = CandleAggregator.aggregate1HTo4H(hourly)
                oneHCandles = hourly
                statusMessage = "1H: \(hourly.count) → 4H: \(fourHCandles.count)"
            }

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
                    candles: Array(dailySlice.suffix(300)), timeframe: "1d", label: "Daily (Trend)", market: market)
                let fourHResult = IndicatorEngine.computeAll(
                    candles: Array(fourHSlice.suffix(300)), timeframe: "4h", label: "4H (Bias)", market: market)
                let oneHResult = IndicatorEngine.computeAll(
                    candles: Array(oneHSlice.suffix(300)), timeframe: "1h", label: "1H (Entry)", market: market)

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

                // ── Trade Outcome Simulation ──
                let tradeResult: TradeSimOutcome?
                if alignment.contains("bearish") || alignment.contains("bullish") {
                    let simATR = fourHResult.atr?.atr ?? (price * 0.015)
                    let isBull = alignment.contains("bullish")
                    let entry = price
                    let stop = isBull ? entry - simATR * 1.5 : entry + simATR * 1.5
                    let tp1 = isBull ? entry + simATR * 1.5 : entry - simATR * 1.5
                    let tp2 = isBull ? entry + simATR * 3.0 : entry - simATR * 3.0
                    let risk = abs(entry - stop)

                    let scanIdx = oneHIdx
                    let maxScan = 24
                    var outcome = "EXPIRED"
                    var bars = maxScan
                    var peakFav = 0.0, peakAdv = 0.0

                    for bar in 0..<maxScan {
                        let idx = scanIdx + bar
                        guard idx < oneHCandles.count else { break }
                        let c = oneHCandles[idx]
                        if isBull {
                            peakFav = max(peakFav, c.high - entry)
                            peakAdv = max(peakAdv, entry - c.low)
                            if c.low <= stop { outcome = "STOPPED"; bars = bar + 1; break }
                            if c.high >= tp2 { outcome = "TP2"; bars = bar + 1; break }
                            if c.high >= tp1 { outcome = "TP1"; bars = bar + 1; break }
                        } else {
                            peakFav = max(peakFav, entry - c.low)
                            peakAdv = max(peakAdv, c.high - entry)
                            if c.high >= stop { outcome = "STOPPED"; bars = bar + 1; break }
                            if c.low <= tp2 { outcome = "TP2"; bars = bar + 1; break }
                            if c.low <= tp1 { outcome = "TP1"; bars = bar + 1; break }
                        }
                    }

                    let pnl: Double
                    switch outcome {
                    case "TP1": pnl = abs(tp1 - entry) / entry * 100
                    case "TP2": pnl = abs(tp2 - entry) / entry * 100
                    case "STOPPED": pnl = -risk / entry * 100
                    default: pnl = 0
                    }

                    tradeResult = TradeSimOutcome(
                        entryPrice: entry, stopPrice: stop, tp1Price: tp1, tp2Price: tp2,
                        riskAmount: risk, outcome: outcome, barsToOutcome: bars,
                        maxFavorable: peakFav, maxAdverse: peakAdv, pnlPercent: pnl)
                } else {
                    tradeResult = nil
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
                    maxFavorable24H: maxFav, maxAdverse24H: maxAdv,
                    tradeResult: tradeResult
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
            opportunityRate: {
                let hits = directional.filter { $0.opportunityHit == true }.count
                return directional.isEmpty ? 0 : Double(hits) / Double(directional.count) * 100
            }(),
            bullishOpportunity: {
                let b = directional.filter { $0.biasAlignment.contains("bullish") }
                let hits = b.filter { $0.opportunityHit == true }.count
                return b.isEmpty ? 0 : Double(hits) / Double(b.count) * 100
            }(),
            bearishOpportunity: {
                let b = directional.filter { $0.biasAlignment.contains("bearish") }
                let hits = b.filter { $0.opportunityHit == true }.count
                return b.isEmpty ? 0 : Double(hits) / Double(b.count) * 100
            }(),
            totalTrades: {
                let trades = points.compactMap(\.tradeResult)
                return trades.count
            }(),
            tp1Wins: points.compactMap(\.tradeResult).filter { $0.outcome == "TP1" }.count,
            tp2Wins: points.compactMap(\.tradeResult).filter { $0.outcome == "TP2" }.count,
            stopped: points.compactMap(\.tradeResult).filter { $0.outcome == "STOPPED" }.count,
            expired: points.compactMap(\.tradeResult).filter { $0.outcome == "EXPIRED" }.count,
            tradeWinRate: {
                let t = points.compactMap(\.tradeResult)
                let wins = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(wins) / Double(t.count) * 100
            }(),
            avgPnlPercent: {
                let t = points.compactMap(\.tradeResult)
                return t.isEmpty ? 0 : t.reduce(0.0) { $0 + $1.pnlPercent } / Double(t.count)
            }(),
            expectancy: {
                let t = points.compactMap(\.tradeResult)
                guard !t.isEmpty else { return 0.0 }
                let wins = t.filter { $0.pnlPercent > 0 }
                let losses = t.filter { $0.pnlPercent < 0 }
                let wr = Double(wins.count) / Double(t.count)
                let avgW = wins.isEmpty ? 0 : wins.reduce(0.0) { $0 + $1.pnlPercent } / Double(wins.count)
                let avgL = losses.isEmpty ? 0 : losses.reduce(0.0) { $0 + $1.pnlPercent } / Double(losses.count)
                return wr * avgW + (1 - wr) * avgL
            }(),
            avgBarsToOutcome: {
                let t = points.compactMap(\.tradeResult)
                return t.isEmpty ? 0 : Double(t.reduce(0) { $0 + $1.barsToOutcome }) / Double(t.count)
            }(),
            trendingWinRate: {
                let t = points.filter { $0.regime == "TRENDING" }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
            rangingWinRate: {
                let t = points.filter { $0.regime == "RANGING" }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
            transitioningWinRate: {
                let t = points.filter { $0.regime == "TRANSITIONING" }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
            strongWinRate: {
                let t = points.filter { abs($0.dailyScore) >= 7 }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
            moderateWinRate: {
                let t = points.filter { abs($0.dailyScore) >= 4 && abs($0.dailyScore) < 7 }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
            weakWinRate: {
                let t = points.filter { abs($0.dailyScore) < 4 }.compactMap(\.tradeResult)
                let w = t.filter { $0.outcome == "TP1" || $0.outcome == "TP2" }.count
                return t.isEmpty ? 0 : Double(w) / Double(t.count) * 100
            }(),
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

            let oppHits = pts.filter { pt in
                guard let maxFav = pt.maxFavorable24H, pt.price > 0, score != 0 else { return false }
                return (maxFav / pt.price) * 100 > 1.0
            }.count

            return ScoreBucket(
                score: score,
                count: pts.count,
                correct24H: correct,
                accuracy: directional.isEmpty ? 0 : Double(correct) / Double(directional.count) * 100,
                opportunity: score == 0 ? 0 : Double(oppHits) / Double(pts.count) * 100,
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
