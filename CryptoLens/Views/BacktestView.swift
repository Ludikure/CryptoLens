import SwiftUI

struct BacktestView: View {
    @StateObject private var engine = BacktestEngine()
    @State private var startDate = Calendar.current.date(byAdding: .year, value: -5, to: Date())!
    @State private var endDate = Date()
    @State private var symbol = "BTCUSDT"

    var body: some View {
        List {
            Section("Configuration") {
                DatePicker("Start", selection: $startDate, displayedComponents: .date)
                DatePicker("End", selection: $endDate, displayedComponents: .date)
                TextField("Symbol", text: $symbol)
                    .textInputAutocapitalization(.characters)
                Text(symbol.hasSuffix("USDT") || symbol.hasSuffix("BTC") ? "Crypto (Binance)" : "Stock (Yahoo)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Button(engine.isRunning ? "Running..." : "Run Backtest") {
                    Task { await engine.run(symbol: symbol, startDate: startDate, endDate: endDate) }
                }
                .disabled(engine.isRunning)

                if engine.isRunning {
                    ProgressView(value: engine.progress)
                    Text(engine.statusMessage).font(.caption).foregroundStyle(.secondary)
                }
            }

            if let r = engine.result {
                Section("Label Accuracy") {
                    row("Bars evaluated", "\(r.evaluatedBars) / \(r.totalBars)")
                    row("Direction correct (4H)", pct(r.accuracy4H))
                    row("Direction correct (24H)", pct(r.accuracy24H))
                    row("Bearish accuracy", pct(r.bearishAccuracy))
                    row("Bullish accuracy", pct(r.bullishAccuracy))
                }

                Section("Opportunity Rate (>1% move in direction)") {
                    row("Overall", pct(r.opportunityRate))
                    row("Bullish opportunity", pct(r.bullishOpportunity))
                    row("Bearish opportunity", pct(r.bearishOpportunity))
                }

                Section("Score Strength") {
                    row("Strong signals", pct(r.strongAccuracy))
                    row("Moderate signals", pct(r.moderateAccuracy))
                    row("Weak signals", pct(r.weakAccuracy))
                }

                Section("By Regime") {
                    row("Trending", pct(r.trendingAccuracy))
                    row("Ranging", pct(r.rangingAccuracy))
                    row("Transitioning", pct(r.transitioningAccuracy))
                }

                Section("Adaptive vs Static") {
                    row("Adaptive thresholds", pct(r.adaptiveAccuracy))
                    row("Static thresholds", pct(r.staticAccuracy))
                    row("Improvement", String(format: "%+.1f%%", r.adaptiveAccuracy - r.staticAccuracy))
                }

                Section("FLAT Analysis") {
                    row("Total FLATs", "\(r.totalFlats)")
                    row("Correct (< 0.5% move)", "\(r.correctFlats)")
                    row("False (> 1.5% missed)", "\(r.falseFlats)")
                    row("FLAT accuracy", pct(r.flatAccuracy))
                }

                Section("Trade Simulation (2.0 ATR, 1:1/1:2 R:R, 72h window)") {
                    row("Total Trades", "\(r.totalTrades)")
                    row("Win Rate", String(format: "%.1f%%", r.tradeWinRate))
                    row("TP1 Wins", "\(r.tp1Wins)")
                    row("TP2 Wins", "\(r.tp2Wins)")
                    row("Stopped Out", "\(r.stopped)")
                    row("Expired", "\(r.expired)")
                    row("Expectancy", String(format: "%.3f%%", r.expectancy))
                    row("Avg Bars to Outcome", String(format: "%.1f hrs", r.avgBarsToOutcome))
                }

                Section("Trade Win Rate by Regime") {
                    row("Trending", pct(r.trendingWinRate))
                    row("Ranging", pct(r.rangingWinRate))
                    row("Transitioning", pct(r.transitioningWinRate))
                }

                Section("Trade Win Rate by Score Strength") {
                    row("Strong (|score| >= 7)", pct(r.strongWinRate))
                    row("Moderate (4-6)", pct(r.moderateWinRate))
                    row("Weak (< 4)", pct(r.weakWinRate))
                }

                Section("Score Distribution (Daily)") {
                    ForEach(r.scoreDistribution) { bucket in
                        HStack {
                            Text("\(bucket.score >= 0 ? "+" : "")\(bucket.score)")
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(bucket.score > 0 ? .green : bucket.score < 0 ? .red : .secondary)
                                .frame(width: 36, alignment: .trailing)
                            Text("\(bucket.count) bars")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 60)
                            Spacer()
                            Text(pct(bucket.accuracy))
                                .fontWeight(.semibold)
                                .foregroundStyle(bucket.accuracy >= 60 ? .green : bucket.accuracy <= 40 ? .red : .primary)
                            Text(String(format: "%+.2f%%", bucket.avgMove))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 60, alignment: .trailing)
                        }
                    }
                }

                if !r.sweepResults.isEmpty {
                    Section("Stop/Target Sweep (by expectancy)") {
                        ForEach(r.sweepResults) { s in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(s.label).font(.caption).fontWeight(.bold)
                                    Spacer()
                                    Text(String(format: "%.3f%%", s.expectancy))
                                        .foregroundStyle(s.expectancy > 0 ? .green : .red)
                                        .font(.caption).fontWeight(.bold)
                                }
                                HStack {
                                    Text("WR: \(pct(s.winRate))")
                                    Text("Res: \(pct(s.resolvedWinRate))")
                                        .foregroundStyle(s.resolvedWinRate >= 55 ? .green : s.resolvedWinRate >= 50 ? .primary : .red)
                                    Spacer()
                                    Text("SL:\(s.stopped) Exp:\(s.expired)")
                                }
                                .font(.caption2).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                Section("Optimal Thresholds (Top 5)") {
                    ForEach(Array(r.thresholdSweep.prefix(5))) { t in
                        HStack {
                            Text("Dir: \(t.directionalThreshold) / Strong: \(t.strongThreshold)")
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text(pct(t.accuracy24H)).fontWeight(.bold)
                                Text("\(t.totalDirectional) trades (\(pct(t.tradeFrequency)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Backtest")
        .toolbar {
            if let r = engine.result {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = shareText(r)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    ShareLink(item: shareText(r), preview: SharePreview("Backtest Results — \(r.symbol)"))
                }
            }
        }
    }

    private func shareText(_ r: BacktestSummary) -> String {
        """
        MarketScope Backtest — \(r.symbol)
        \(r.startDate.formatted(date: .abbreviated, time: .omitted)) → \(r.endDate.formatted(date: .abbreviated, time: .omitted))

        Label Accuracy:
        • Bars evaluated: \(r.evaluatedBars) / \(r.totalBars)
        • Direction correct (4H): \(pct(r.accuracy4H))
        • Direction correct (24H): \(pct(r.accuracy24H))
        • Bearish: \(pct(r.bearishAccuracy)) | Bullish: \(pct(r.bullishAccuracy))

        Opportunity Rate (>1% move in direction):
        • Overall: \(pct(r.opportunityRate))
        • Bullish: \(pct(r.bullishOpportunity)) | Bearish: \(pct(r.bearishOpportunity))

        Score Strength:
        • Strong: \(pct(r.strongAccuracy)) | Moderate: \(pct(r.moderateAccuracy)) | Weak: \(pct(r.weakAccuracy))

        By Regime:
        • Trending: \(pct(r.trendingAccuracy)) | Ranging: \(pct(r.rangingAccuracy)) | Transitioning: \(pct(r.transitioningAccuracy))

        Adaptive vs Static:
        • Adaptive: \(pct(r.adaptiveAccuracy)) | Static: \(pct(r.staticAccuracy)) | Delta: \(String(format: "%+.1f%%", r.adaptiveAccuracy - r.staticAccuracy))

        FLAT Analysis:
        • Total: \(r.totalFlats) | Correct: \(r.correctFlats) | False: \(r.falseFlats) | Accuracy: \(pct(r.flatAccuracy))

        Trade Simulation (1.5 ATR stop, 1:1/1:2 R:R):
        • Trades: \(r.totalTrades) | Win Rate: \(pct(r.tradeWinRate))
        • TP1: \(r.tp1Wins) | TP2: \(r.tp2Wins) | Stopped: \(r.stopped) | Expired: \(r.expired)
        • Expectancy: \(String(format: "%.3f%%", r.expectancy)) | Avg \(String(format: "%.1f", r.avgBarsToOutcome))h
        • By Regime: Trend \(pct(r.trendingWinRate)) | Range \(pct(r.rangingWinRate)) | Trans \(pct(r.transitioningWinRate))
        • By Strength: Strong \(pct(r.strongWinRate)) | Mod \(pct(r.moderateWinRate)) | Weak \(pct(r.weakWinRate))

        Stop/Target Sweep:
        \(r.sweepResults.map { "• \($0.label): WR \(pct($0.winRate)) Res \(pct($0.resolvedWinRate)), Exp \(String(format: "%.3f%%", $0.expectancy)), TP1 \($0.tp1Wins) TP2 \($0.tp2Wins) SL \($0.stopped) Expired \($0.expired)" }.joined(separator: "\n"))

        Score Distribution (Daily):
        \(r.scoreDistribution.map { "\($0.score >= 0 ? "+" : "")\($0.score): \($0.count) bars, \(pct($0.accuracy)) acc, \(String(format: "%+.2f%%", $0.avgMove)) avg move" }.joined(separator: "\n"))

        Top Threshold: Dir \(r.thresholdSweep.first?.directionalThreshold ?? 0) / Strong \(r.thresholdSweep.first?.strongThreshold ?? 0) → \(pct(r.thresholdSweep.first?.accuracy24H ?? 0))
        """
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundStyle(.secondary)
        }
    }

    private func pct(_ v: Double) -> String { String(format: "%.1f%%", v) }
}
