import SwiftUI

struct OptimizerView: View {
    @StateObject private var engine = OptimizerEngine()
    @State private var market: Market = .crypto
    @State private var startDate = Calendar.current.date(byAdding: .year, value: -1, to: Date())!
    @State private var endDate = Date()
    @State private var symbolInput = ""
    @State private var symbols: [String] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

    var body: some View {
        List {
            Section("Configuration") {
                Picker("Market", selection: $market) {
                    ForEach(Market.allCases) { m in
                        Text(m.displayName).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: market) {
                    symbols = market == .crypto
                        ? ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
                        : ["AAPL", "MSFT", "NVDA"]
                }

                DatePicker("Start", selection: $startDate, displayedComponents: .date)
                DatePicker("End", selection: $endDate, displayedComponents: .date)
            }

            Section("Symbols") {
                ForEach(symbols, id: \.self) { sym in
                    HStack {
                        Text(sym)
                            .font(.system(.body, design: .monospaced))
                        Spacer()
                        Button(role: .destructive) {
                            symbols.removeAll { $0 == sym }
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red)
                        }
                    }
                }

                HStack {
                    TextField("Add symbol", text: $symbolInput)
                        .textInputAutocapitalization(.characters)
                    Button("Add") {
                        let trimmed = symbolInput.trimmingCharacters(in: .whitespaces).uppercased()
                        if !trimmed.isEmpty && !symbols.contains(trimmed) {
                            symbols.append(trimmed)
                            symbolInput = ""
                        }
                    }
                    .disabled(symbolInput.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            Section {
                Button(engine.isRunning ? "Running..." : "Run Optimizer") {
                    Task {
                        await engine.run(symbols: symbols, market: market,
                                          startDate: startDate, endDate: endDate)
                    }
                }
                .disabled(engine.isRunning || symbols.isEmpty)

                if engine.isRunning {
                    ProgressView(value: engine.progress)
                    Text(engine.statusMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let best = engine.bestResult {
                Section("Winner") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(best.params.label)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                        HStack {
                            metricBadge("Train Opp", String(format: "%.1f%%", best.avgTrainOpp), .blue)
                            metricBadge("Valid Opp", String(format: "%.1f%%", best.avgValidOpp), .green)
                            metricBadge("Gap", String(format: "%.1f%%", best.gap), best.gap < 10 ? .green : .orange)
                        }
                        HStack {
                            metricBadge("Worst Train", String(format: "%.1f%%", best.worstTrainOpp), .blue)
                            metricBadge("Worst Valid", String(format: "%.1f%%", best.worstValidOpp), .green)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Winner - Train Metrics") {
                    ForEach(best.trainMetrics) { m in
                        assetRow(m)
                    }
                }

                Section("Winner - Validation Metrics") {
                    ForEach(best.validMetrics) { m in
                        assetRow(m)
                    }
                }

                Section {
                    Button("Apply Winner") {
                        engine.applyBest()
                    }
                    .foregroundStyle(.green)
                }
            }

            if engine.results.count > 1 {
                Section("Top 10 Results") {
                    ForEach(Array(engine.results.enumerated()), id: \.element.id) { idx, result in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("#\(idx + 1)")
                                    .font(.caption).fontWeight(.bold)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(String(format: "Worst Valid: %.1f%%", result.worstValidOpp))
                                    .font(.caption)
                                    .foregroundStyle(.green)
                                Text(String(format: "Gap: %.1f%%", result.gap))
                                    .font(.caption)
                                    .foregroundStyle(result.gap < 10 ? .green : .orange)
                            }
                            Text(result.params.label)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section {
                HStack {
                    Text("Candle Cache")
                    Spacer()
                    Text(CandleCache.totalCacheSize)
                        .foregroundStyle(.secondary)
                }

                Button("Clear All Caches", role: .destructive) {
                    CandleCache.clearAll()
                    SnapshotCache.clearAll()
                    engine.statusMessage = "Caches cleared"
                }
            } header: {
                Text("Cache")
            }
        }
        .navigationTitle("Optimizer")
    }

    // MARK: - Subviews

    private func assetRow(_ m: OptimizerMetrics) -> some View {
        HStack {
            Text(m.symbol)
                .font(.system(.body, design: .monospaced))
                .frame(width: 90, alignment: .leading)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(String(format: "Opp: %.1f%%", m.opportunityRate))
                    .font(.caption)
                Text(String(format: "Acc: %.1f%%", m.accuracy24H))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("\(m.directionalBars)/\(m.totalBars)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 55, alignment: .trailing)
        }
    }

    private func metricBadge(_ title: String, _ value: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }
}
