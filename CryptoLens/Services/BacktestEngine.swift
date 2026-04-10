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
    private let twelveData = TwelveDataProvider()
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
                    yahoo: yahoo, alphaVantage: alphaVantage, twelveData: twelveData)
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

                guard dailyIdx >= 210, i + 1 >= 210, oneHIdx >= 30 else { continue }

                let dailyResult = IndicatorEngine.computeAll(
                    candles: Array(dailyCandles[max(0, dailyIdx - 300)..<dailyIdx]),
                    timeframe: "1d", label: "Daily (Trend)", market: market)
                let fourHResult = IndicatorEngine.computeAll(
                    candles: Array(fourHCandles[max(0, i + 1 - 300)...i]),
                    timeframe: "4h", label: "4H (Bias)", market: market)
                let oneHResult = IndicatorEngine.computeAll(
                    candles: Array(oneHCandles[max(0, oneHIdx - 300)..<oneHIdx]),
                    timeframe: "1h", label: "1H (Entry)", market: market)

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
                    let stop = isBull ? entry - simATR * 2.0 : entry + simATR * 2.0
                    let tp1 = isBull ? entry + simATR * 2.0 : entry - simATR * 2.0
                    let tp2 = isBull ? entry + simATR * 4.0 : entry - simATR * 4.0
                    let risk = abs(entry - stop)

                    let scanIdx = oneHIdx
                    let maxScan = 72  // 72h scan window (backtest-proven optimal for 2.0 ATR)
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
                // Set entryContext for ALL bars (needed for conflict sweep)
                // Aligned bars use alignment direction; conflict/neutral use Daily direction
                let ctxBullish = alignment.contains("bullish") ? true :
                                 alignment.contains("bearish") ? false :
                                 dBullish
                let entryContext = TradeEntryContext(
                    price: price,
                    isBullish: ctxBullish,
                    atr: fourHResult.atr?.atr ?? (price * 0.015),
                    oneHStartIdx: oneHIdx)

                // Extract ML features from indicator results
                let mlf = MLFeatures(
                    dRsi: dailyResult.rsi ?? 50, dMacdHist: dailyResult.macd?.histogram ?? 0,
                    dAdx: dailyResult.adx?.adx ?? 0, dAdxBullish: dailyResult.adx?.direction == "Bullish",
                    dEmaCross: {
                        var c = 0
                        if let e = dailyResult.ema20 { c += price > e ? 1 : -1 }
                        if let e = dailyResult.ema50 { c += price > e ? 1 : -1 }
                        if let e = dailyResult.ema200 { c += price > e ? 1 : -1 }
                        return c
                    }(),
                    dStackBull: maAlign == "bullish_stacked", dStackBear: maAlign == "bearish_stacked",
                    dStructBull: dailyResult.marketStructure?.label.contains("bullish") ?? false,
                    dStructBear: dailyResult.marketStructure?.label.contains("bearish") ?? false,
                    hRsi: fourHResult.rsi ?? 50, hMacdHist: fourHResult.macd?.histogram ?? 0,
                    hAdx: fourHResult.adx?.adx ?? 0, hAdxBullish: fourHResult.adx?.direction == "Bullish",
                    hEmaCross: {
                        var c = 0
                        if let e = fourHResult.ema20 { c += price > e ? 1 : -1 }
                        if let e = fourHResult.ema50 { c += price > e ? 1 : -1 }
                        if let e = fourHResult.ema200 { c += price > e ? 1 : -1 }
                        return c
                    }(),
                    hStackBull: {
                        if let e20 = fourHResult.ema20, let e50 = fourHResult.ema50, let e200 = fourHResult.ema200 {
                            return e20 > e50 && e50 > e200
                        }; return false
                    }(),
                    hStackBear: {
                        if let e20 = fourHResult.ema20, let e50 = fourHResult.ema50, let e200 = fourHResult.ema200 {
                            return e20 < e50 && e50 < e200
                        }; return false
                    }(),
                    hStructBull: fourHResult.marketStructure?.label.contains("bullish") ?? false,
                    hStructBear: fourHResult.marketStructure?.label.contains("bearish") ?? false,
                    atrPercent: fourHResult.atr?.atrPercent ?? 0,
                    isCrypto: isCrypto
                )

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
                    tradeResult: tradeResult,
                    entryContext: entryContext,
                    mlFeatures: mlf
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

            statusMessage = "Running stop/target sweep..."
            result?.sweepResults = runSweep(points: points, oneHCandles: oneHCandles)

            statusMessage = "Complete: \(points.count) bars evaluated"
        } catch {
            statusMessage = "Error: \(error.localizedDescription)"
        }
        isRunning = false
    }

    // MARK: - ML CSV Export

    /// Export backtest data points as CSV for ML training.
    /// Each row has: scores, regime, alignment, trade outcome (resolved TP/SL from bar-by-bar sim).
    func exportCSV() -> String? {
        guard !dataPoints.isEmpty else { return nil }
        let header = [
            "timestamp", "price",
            "dailyScore", "fourHScore", "oneHScore",
            "dailyBias", "fourHBias", "oneHBias",
            "biasAlignment", "regime", "emaRegime",
            "volScalar", "atrPercentile",
            // ML features — Daily
            "dRsi", "dMacdHist", "dAdx", "dAdxBullish",
            "dEmaCross", "dStackBull", "dStackBear", "dStructBull", "dStructBear",
            // ML features — 4H
            "hRsi", "hMacdHist", "hAdx", "hAdxBullish",
            "hEmaCross", "hStackBull", "hStackBear", "hStructBull", "hStructBear",
            "atrPercent", "isCrypto",
            // Trade outcome (bar-by-bar resolved)
            "tradeOutcome", "tradePnlPct", "tradeBarsToOutcome",
            "tradeMaxFavorable", "tradeMaxAdverse"
        ].joined(separator: ",")

        var csv = header + "\n"
        for pt in dataPoints {
            let outcome = pt.tradeResult?.outcome ?? "NONE"
            let pnl = pt.tradeResult?.pnlPercent ?? 0
            let bars = pt.tradeResult?.barsToOutcome ?? 0
            let maxFav = pt.tradeResult?.maxFavorable ?? 0
            let maxAdv = pt.tradeResult?.maxAdverse ?? 0
            let f = pt.mlFeatures

            let row = [
                "\(Int(pt.timestamp.timeIntervalSince1970))",
                "\(pt.price)",
                "\(pt.dailyScore)", "\(pt.fourHScore)", "\(pt.oneHScore)",
                pt.dailyBias, pt.fourHBias, pt.oneHBias,
                pt.biasAlignment, pt.regime, pt.emaRegime,
                String(format: "%.2f", pt.volScalar),
                String(format: "%.0f", pt.atrPercentile),
                // ML features — Daily
                String(format: "%.1f", f?.dRsi ?? 50),
                String(format: "%.6f", f?.dMacdHist ?? 0),
                String(format: "%.1f", f?.dAdx ?? 0),
                "\(f?.dAdxBullish == true ? 1 : 0)",
                "\(f?.dEmaCross ?? 0)",
                "\(f?.dStackBull == true ? 1 : 0)", "\(f?.dStackBear == true ? 1 : 0)",
                "\(f?.dStructBull == true ? 1 : 0)", "\(f?.dStructBear == true ? 1 : 0)",
                // ML features — 4H
                String(format: "%.1f", f?.hRsi ?? 50),
                String(format: "%.6f", f?.hMacdHist ?? 0),
                String(format: "%.1f", f?.hAdx ?? 0),
                "\(f?.hAdxBullish == true ? 1 : 0)",
                "\(f?.hEmaCross ?? 0)",
                "\(f?.hStackBull == true ? 1 : 0)", "\(f?.hStackBear == true ? 1 : 0)",
                "\(f?.hStructBull == true ? 1 : 0)", "\(f?.hStructBear == true ? 1 : 0)",
                String(format: "%.4f", f?.atrPercent ?? 0),
                "\(f?.isCrypto == true ? 1 : 0)",
                // Trade outcome
                outcome, String(format: "%.4f", pnl), "\(bars)",
                String(format: "%.4f", maxFav), String(format: "%.4f", maxAdv)
            ].joined(separator: ",")
            csv += row + "\n"
        }
        return csv
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
                let lr = Double(losses.count) / Double(t.count)
                return wr * avgW + lr * avgL
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
            sweepResults: [],  // Populated after computeSummary
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

    private func runSweep(points: [BacktestDataPoint], oneHCandles: [Candle]) -> [SweepResult] {
        struct SC {
            let label: String; let stopDesc: String; let tp1Desc: String; let tp2Desc: String
            let distances: (Double, Double) -> (Double, Double, Double)
        }
        let sizeConfigs: [SC] = [
            SC(label: "0.75/0.75/1.5 ATR", stopDesc: "0.75 ATR", tp1Desc: "0.75 ATR", tp2Desc: "1.5 ATR",
               distances: { _, a in (a*0.75, a*0.75, a*1.5) }),
            SC(label: "1.0/1.0/2.0 ATR", stopDesc: "1.0 ATR", tp1Desc: "1.0 ATR", tp2Desc: "2.0 ATR",
               distances: { _, a in (a*1.0, a*1.0, a*2.0) }),
            SC(label: "1.5/1.5/3.0 ATR", stopDesc: "1.5 ATR", tp1Desc: "1.5 ATR", tp2Desc: "3.0 ATR",
               distances: { _, a in (a*1.5, a*1.5, a*3.0) }),
            SC(label: "2.0/2.0/4.0 ATR", stopDesc: "2.0 ATR", tp1Desc: "2.0 ATR", tp2Desc: "4.0 ATR",
               distances: { _, a in (a*2.0, a*2.0, a*4.0) }),
            SC(label: "1.0%/1.0%/1.5%", stopDesc: "1.0%", tp1Desc: "1.0%", tp2Desc: "1.5%",
               distances: { p, _ in (p*0.01, p*0.01, p*0.015) }),
            SC(label: "0.75%/0.75%/1.25%", stopDesc: "0.75%", tp1Desc: "0.75%", tp2Desc: "1.25%",
               distances: { p, _ in (p*0.0075, p*0.0075, p*0.0125) }),
        ]
        let scanWindows = [24, 48, 72]  // hours

        var results = [SweepResult]()
        for window in scanWindows {
            for cfg in sizeConfigs {
                var tp1W = 0, tp2W = 0, stoppedN = 0, expiredN = 0
                var totalPnlW = 0.0, totalPnlL = 0.0, totalBars = 0, tradeCount = 0

                for pt in points {
                    guard let ctx = pt.entryContext else { continue }
                    tradeCount += 1
                    let (sd, t1d, t2d) = cfg.distances(ctx.price, ctx.atr)
                    let e = ctx.price
                    let s = ctx.isBullish ? e - sd : e + sd
                    let t1 = ctx.isBullish ? e + t1d : e - t1d
                    let t2 = ctx.isBullish ? e + t2d : e - t2d

                    var outcome = "EXPIRED"; var bars = window
                    for bar in 0..<window {
                        let idx = ctx.oneHStartIdx + bar
                        guard idx < oneHCandles.count else { break }
                        let c = oneHCandles[idx]
                        if ctx.isBullish {
                            if c.low <= s { outcome = "STOPPED"; bars = bar+1; break }
                            if c.high >= t2 { outcome = "TP2"; bars = bar+1; break }
                            if c.high >= t1 { outcome = "TP1"; bars = bar+1; break }
                        } else {
                            if c.high >= s { outcome = "STOPPED"; bars = bar+1; break }
                            if c.low <= t2 { outcome = "TP2"; bars = bar+1; break }
                            if c.low <= t1 { outcome = "TP1"; bars = bar+1; break }
                        }
                    }
                    totalBars += bars
                    switch outcome {
                    case "TP1": tp1W += 1; totalPnlW += t1d / e * 100
                    case "TP2": tp2W += 1; totalPnlW += t2d / e * 100
                    case "STOPPED": stoppedN += 1; totalPnlL += sd / e * 100
                    default: expiredN += 1
                    }
                }
                let wins = tp1W + tp2W
                let resolved = wins + stoppedN
                let wr = tradeCount > 0 ? Double(wins) / Double(tradeCount) * 100 : 0
                let resolvedWR = resolved > 0 ? Double(wins) / Double(resolved) * 100 : 0
                let avgW = wins > 0 ? totalPnlW / Double(wins) : 0
                let avgL = stoppedN > 0 ? -totalPnlL / Double(stoppedN) : 0
                let exp = tradeCount > 0
                    ? (Double(wins)/Double(tradeCount))*avgW + (Double(stoppedN)/Double(tradeCount))*avgL : 0

                results.append(SweepResult(
                    label: "\(cfg.label) / \(window)h", stopDesc: cfg.stopDesc, tp1Desc: cfg.tp1Desc, tp2Desc: cfg.tp2Desc,
                    totalTrades: tradeCount, tp1Wins: tp1W, tp2Wins: tp2W, stopped: stoppedN, expired: expiredN,
                    winRate: wr, resolvedWinRate: resolvedWR, expectancy: exp,
                    avgBarsToOutcome: tradeCount > 0 ? Double(totalBars)/Double(tradeCount) : 0))
            }
        }
        // ── Score-filtered sweep on best config (2.0 ATR / 72h) ──
        let bestCfg = SC(label: "2.0/2.0/4.0 ATR", stopDesc: "2.0 ATR", tp1Desc: "2.0 ATR", tp2Desc: "4.0 ATR",
                         distances: { _, a in (a*2.0, a*2.0, a*4.0) })
        for (filterLabel, minScore) in [("all", 0), ("|s|≥3", 3), ("|s|≥4", 4), ("|s|≥5", 5), ("|s|≥6", 6), ("|s|≥7", 7)] {
            var tp1W = 0, tp2W = 0, stoppedN = 0, expiredN = 0
            var totalPnlW = 0.0, totalPnlL = 0.0, totalBars = 0, tradeCount = 0
            for pt in points {
                guard let ctx = pt.entryContext, abs(pt.dailyScore) >= minScore else { continue }
                tradeCount += 1
                let (sd, t1d, t2d) = bestCfg.distances(ctx.price, ctx.atr)
                let e = ctx.price
                let s = ctx.isBullish ? e - sd : e + sd
                let t1 = ctx.isBullish ? e + t1d : e - t1d
                let t2 = ctx.isBullish ? e + t2d : e - t2d
                var outcome = "EXPIRED"; var bars = 72
                for bar in 0..<72 {
                    let idx = ctx.oneHStartIdx + bar
                    guard idx < oneHCandles.count else { break }
                    let c = oneHCandles[idx]
                    if ctx.isBullish {
                        if c.low <= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.high >= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.high >= t1 { outcome = "TP1"; bars = bar+1; break }
                    } else {
                        if c.high >= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.low <= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.low <= t1 { outcome = "TP1"; bars = bar+1; break }
                    }
                }
                totalBars += bars
                switch outcome {
                case "TP1": tp1W += 1; totalPnlW += t1d / e * 100
                case "TP2": tp2W += 1; totalPnlW += t2d / e * 100
                case "STOPPED": stoppedN += 1; totalPnlL += sd / e * 100
                default: expiredN += 1
                }
            }
            let wins = tp1W + tp2W
            let resolved = wins + stoppedN
            let wr = tradeCount > 0 ? Double(wins) / Double(tradeCount) * 100 : 0
            let resolvedWR = resolved > 0 ? Double(wins) / Double(resolved) * 100 : 0
            let avgW = wins > 0 ? totalPnlW / Double(wins) : 0
            let avgL = stoppedN > 0 ? -totalPnlL / Double(stoppedN) : 0
            let exp = tradeCount > 0 ? (Double(wins)/Double(tradeCount))*avgW + (Double(stoppedN)/Double(tradeCount))*avgL : 0
            results.append(SweepResult(
                label: "2.0ATR/72h \(filterLabel)", stopDesc: "2.0 ATR", tp1Desc: "2.0 ATR", tp2Desc: "4.0 ATR",
                totalTrades: tradeCount, tp1Wins: tp1W, tp2Wins: tp2W, stopped: stoppedN, expired: expiredN,
                winRate: wr, resolvedWinRate: resolvedWR, expectancy: exp,
                avgBarsToOutcome: tradeCount > 0 ? Double(totalBars)/Double(tradeCount) : 0))
        }

        // ── Rule 2 Override Test: trade Daily direction even when 4H conflicts ──
        for (filterLabel, minScore) in [("conflict |s|≥7", 7), ("conflict |s|≥8", 8), ("conflict |s|≥9", 9)] {
            var tp1W = 0, tp2W = 0, stoppedN = 0, expiredN = 0
            var totalPnlW = 0.0, totalPnlL = 0.0, totalBars = 0, tradeCount = 0

            for pt in points {
                // ONLY conflict bars (currently skipped as FLAT)
                guard pt.biasAlignment == "conflict" || pt.biasAlignment == "neutral" else { continue }
                guard abs(pt.dailyScore) >= minScore else { continue }
                guard let ctx = pt.entryContext else { continue }

                // Trade in Daily's direction, ignoring 4H
                let isBullish = pt.dailyBias.contains("Bullish")
                let isBearish = pt.dailyBias.contains("Bearish")
                guard isBullish || isBearish else { continue }

                tradeCount += 1
                let atr = ctx.atr
                let e = ctx.price
                let sd = atr * 2.0; let t1d = atr * 2.0; let t2d = atr * 4.0
                let s = isBullish ? e - sd : e + sd
                let t1 = isBullish ? e + t1d : e - t1d
                let t2 = isBullish ? e + t2d : e - t2d

                var outcome = "EXPIRED"; var bars = 72
                for bar in 0..<72 {
                    let idx = ctx.oneHStartIdx + bar
                    guard idx < oneHCandles.count else { break }
                    let c = oneHCandles[idx]
                    if isBullish {
                        if c.low <= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.high >= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.high >= t1 { outcome = "TP1"; bars = bar+1; break }
                    } else {
                        if c.high >= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.low <= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.low <= t1 { outcome = "TP1"; bars = bar+1; break }
                    }
                }
                totalBars += bars
                switch outcome {
                case "TP1": tp1W += 1; totalPnlW += t1d / e * 100
                case "TP2": tp2W += 1; totalPnlW += t2d / e * 100
                case "STOPPED": stoppedN += 1; totalPnlL += sd / e * 100
                default: expiredN += 1
                }
            }

            let wins = tp1W + tp2W
            let resolved = wins + stoppedN
            let wr = tradeCount > 0 ? Double(wins) / Double(tradeCount) * 100 : 0
            let resolvedWR = resolved > 0 ? Double(wins) / Double(resolved) * 100 : 0
            let avgW = wins > 0 ? totalPnlW / Double(wins) : 0
            let avgL = stoppedN > 0 ? -totalPnlL / Double(stoppedN) : 0
            let exp = tradeCount > 0
                ? (Double(wins)/Double(tradeCount))*avgW + (Double(stoppedN)/Double(tradeCount))*avgL : 0

            results.append(SweepResult(
                label: "R2 override \(filterLabel)",
                stopDesc: "2.0 ATR", tp1Desc: "2.0 ATR", tp2Desc: "4.0 ATR",
                totalTrades: tradeCount, tp1Wins: tp1W, tp2Wins: tp2W,
                stopped: stoppedN, expired: expiredN,
                winRate: wr, resolvedWinRate: resolvedWR, expectancy: exp,
                avgBarsToOutcome: tradeCount > 0 ? Double(totalBars)/Double(tradeCount) : 0))
        }

        // ── Score Authority Test: which timeframe predicts best? ──
        for (filterLabel, filter) in [
            // Daily only (current system)
            ("Daily |s|≥5", { (pt: BacktestDataPoint) in abs(pt.dailyScore) >= 5 }),
            ("Daily |s|≥6", { (pt: BacktestDataPoint) in abs(pt.dailyScore) >= 6 }),
            ("Daily |s|≥7", { (pt: BacktestDataPoint) in abs(pt.dailyScore) >= 7 }),
            // 4H only
            ("4H |s|≥5", { (pt: BacktestDataPoint) in abs(pt.fourHScore) >= 5 }),
            ("4H |s|≥6", { (pt: BacktestDataPoint) in abs(pt.fourHScore) >= 6 }),
            ("4H |s|≥7", { (pt: BacktestDataPoint) in abs(pt.fourHScore) >= 7 }),
            // Either (max of both)
            ("Either |s|≥5", { (pt: BacktestDataPoint) in max(abs(pt.dailyScore), abs(pt.fourHScore)) >= 5 }),
            ("Either |s|≥6", { (pt: BacktestDataPoint) in max(abs(pt.dailyScore), abs(pt.fourHScore)) >= 6 }),
            ("Either |s|≥7", { (pt: BacktestDataPoint) in max(abs(pt.dailyScore), abs(pt.fourHScore)) >= 7 }),
            // Both (min of both)
            ("Both |s|≥5", { (pt: BacktestDataPoint) in min(abs(pt.dailyScore), abs(pt.fourHScore)) >= 5 }),
            ("Both |s|≥7", { (pt: BacktestDataPoint) in min(abs(pt.dailyScore), abs(pt.fourHScore)) >= 7 }),
        ] as [(String, (BacktestDataPoint) -> Bool)] {
            var tp1W = 0, tp2W = 0, stoppedN = 0, expiredN = 0
            var totalPnlW = 0.0, totalPnlL = 0.0, totalBars = 0, tradeCount = 0

            for pt in points {
                guard let ctx = pt.entryContext else { continue }
                guard filter(pt) else { continue }

                // Trade direction: use whichever timeframe has higher |score|
                let useDailyDir = abs(pt.dailyScore) >= abs(pt.fourHScore)
                let dirBias = useDailyDir ? pt.dailyBias : pt.fourHBias
                let isBullish = dirBias.contains("Bullish")
                let isBearish = dirBias.contains("Bearish")
                guard isBullish || isBearish else { continue }

                tradeCount += 1
                let atr = ctx.atr; let e = ctx.price
                let sd = atr * 2.0; let t1d = atr * 2.0; let t2d = atr * 4.0
                let s = isBullish ? e - sd : e + sd
                let t1 = isBullish ? e + t1d : e - t1d
                let t2 = isBullish ? e + t2d : e - t2d

                var outcome = "EXPIRED"; var bars = 72
                for bar in 0..<72 {
                    let idx = ctx.oneHStartIdx + bar
                    guard idx < oneHCandles.count else { break }
                    let c = oneHCandles[idx]
                    if isBullish {
                        if c.low <= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.high >= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.high >= t1 { outcome = "TP1"; bars = bar+1; break }
                    } else {
                        if c.high >= s { outcome = "STOPPED"; bars = bar+1; break }
                        if c.low <= t2 { outcome = "TP2"; bars = bar+1; break }
                        if c.low <= t1 { outcome = "TP1"; bars = bar+1; break }
                    }
                }
                totalBars += bars
                switch outcome {
                case "TP1": tp1W += 1; totalPnlW += t1d / e * 100
                case "TP2": tp2W += 1; totalPnlW += t2d / e * 100
                case "STOPPED": stoppedN += 1; totalPnlL += sd / e * 100
                default: expiredN += 1
                }
            }

            let wins = tp1W + tp2W
            let resolved = wins + stoppedN
            let wr = tradeCount > 0 ? Double(wins) / Double(tradeCount) * 100 : 0
            let resolvedWR = resolved > 0 ? Double(wins) / Double(resolved) * 100 : 0
            let avgW = wins > 0 ? totalPnlW / Double(wins) : 0
            let avgL = stoppedN > 0 ? -totalPnlL / Double(stoppedN) : 0
            let exp = tradeCount > 0
                ? (Double(wins)/Double(tradeCount))*avgW + (Double(stoppedN)/Double(tradeCount))*avgL : 0

            results.append(SweepResult(
                label: filterLabel,
                stopDesc: "2.0 ATR", tp1Desc: "2.0 ATR", tp2Desc: "4.0 ATR",
                totalTrades: tradeCount, tp1Wins: tp1W, tp2Wins: tp2W,
                stopped: stoppedN, expired: expiredN,
                winRate: wr, resolvedWinRate: resolvedWR, expectancy: exp,
                avgBarsToOutcome: tradeCount > 0 ? Double(totalBars)/Double(tradeCount) : 0))
        }

        return results.sorted { $0.expectancy > $1.expectancy }
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
