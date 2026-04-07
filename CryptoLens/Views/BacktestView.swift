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
