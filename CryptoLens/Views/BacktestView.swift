import SwiftUI

struct BacktestView: View {
    @StateObject private var engine = BacktestEngine()
    @State private var startDate = Calendar.current.date(byAdding: .month, value: -6, to: Date())!
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

        Score Strength:
        • Strong: \(pct(r.strongAccuracy)) | Moderate: \(pct(r.moderateAccuracy)) | Weak: \(pct(r.weakAccuracy))

        By Regime:
        • Trending: \(pct(r.trendingAccuracy)) | Ranging: \(pct(r.rangingAccuracy)) | Transitioning: \(pct(r.transitioningAccuracy))

        Adaptive vs Static:
        • Adaptive: \(pct(r.adaptiveAccuracy)) | Static: \(pct(r.staticAccuracy)) | Delta: \(String(format: "%+.1f%%", r.adaptiveAccuracy - r.staticAccuracy))

        FLAT Analysis:
        • Total: \(r.totalFlats) | Correct: \(r.correctFlats) | False: \(r.falseFlats) | Accuracy: \(pct(r.flatAccuracy))

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
