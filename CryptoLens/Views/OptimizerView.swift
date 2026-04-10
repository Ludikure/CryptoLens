import SwiftUI

struct OptimizerView: View {
    @StateObject private var engine = OptimizerEngine()
    @State private var market: Market = .crypto
    @State private var startDate = Calendar.current.date(byAdding: .year, value: -5, to: Date())!
    @State private var endDate = Date()
    @State private var symbolInput = ""
    @State private var showAppliedAlert = false
    @State private var symbols: [String] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    @State private var layerResults: [LayerDiagnostic.LayerResult] = []
    @State private var marginalResults: [LayerDiagnostic.LayerResult] = []
    @State private var showDiagnostic = false

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
                    Button("Apply Winner to \(market == .crypto ? "Crypto" : "Stock")") {
                        engine.applyBest(for: market)
                        showAppliedAlert = true
                    }
                    .foregroundStyle(.green)

                    // Show currently active params
                    if let active = ScoringParams.loadSaved(for: market) {
                        HStack {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            Text("Active: \(active.label)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        HStack {
                            Image(systemName: "info.circle").foregroundStyle(.secondary)
                            Text("Using defaults")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if engine.results.count > 1 {
                if !engine.macroBreakdown.isEmpty {
                    Section("By VIX Regime") {
                        ForEach(engine.macroBreakdown) { m in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(m.regime).fontWeight(.bold)
                                    Text("VIX \(m.vixRange)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                VStack(alignment: .trailing) {
                                    Text(String(format: "Opp: %.1f%%", m.oppRate))
                                    Text(String(format: "Acc: %.1f%% | %d bars", m.accuracy, m.barCount))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

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

                Button("Export Snapshots CSV") { exportSnapshots() }

                Button("Clear All Caches", role: .destructive) {
                    CandleCache.clearAll()
                    SnapshotCache.clearAll()
                    DerivativesCache.clearAll()
                    engine.statusMessage = "Caches cleared"
                }

                Button("Run Layer Diagnostic") {
                    let params = ScoringParams.loadSaved(for: market) ?? (market == .crypto ? .cryptoDefault : .stockDefault)
                    // Collect all cached snapshots across symbols
                    var allSnaps = [ScoringSnapshot]()
                    for sym in symbols {
                        if let snaps = SnapshotCache.load(symbol: sym, timeframe: "daily_4h") {
                            allSnaps.append(contentsOf: snaps)
                        }
                    }
                    guard !allSnaps.isEmpty else {
                        engine.statusMessage = "No cached snapshots — run optimizer first"
                        return
                    }
                    layerResults = LayerDiagnostic.diagnose(snapshots: allSnaps)
                    marginalResults = LayerDiagnostic.marginalContribution(snapshots: allSnaps, baseParams: params)
                    showDiagnostic = true
                    engine.statusMessage = "Diagnostic: \(allSnaps.count) snapshots analyzed"
                }
            } header: {
                Text("Cache & Diagnostics")
            }

            if showDiagnostic {
                Section("Isolated Layer Accuracy") {
                    ForEach(layerResults) { r in
                        HStack {
                            Text(r.name).font(.caption)
                            Spacer()
                            Text(String(format: "%.1f%%", r.accuracy24H))
                                .fontWeight(.bold)
                                .foregroundStyle(r.accuracy24H >= 55 ? .green : r.accuracy24H < 50 ? .red : .primary)
                            Text(String(format: "%.0f", r.avgContribution))
                                .font(.caption2).foregroundStyle(.secondary).frame(width: 25)
                        }
                    }
                }

                Section("Marginal Contribution (remove → accuracy)") {
                    ForEach(marginalResults) { r in
                        HStack {
                            Text(r.name).font(.caption)
                            Spacer()
                            Text(String(format: "%.1f%%", r.accuracy24H))
                                .fontWeight(.bold)
                                .foregroundStyle(r.name == "Base (all layers)" ? .blue :
                                    r.accuracy24H > (marginalResults.first?.accuracy24H ?? 0) ? .green : .primary)
                            Text("\(r.totalDirectional)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Optimizer")
        .alert("Parameters Applied", isPresented: $showAppliedAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Optimized \(market == .crypto ? "crypto" : "stock") parameters are now active. Next analysis will use them.")
        }
        .toolbar {
            if engine.bestResult != nil {
                Button {
                    UIPasteboard.general.string = shareText()
                } label: {
                    Image(systemName: "doc.on.doc")
                }
            }
        }
    }

    private func exportSnapshots() {
        let sym = symbols.first ?? "BTCUSDT"
        if let csv = exportSnapshotCSV(symbol: sym) {
            UIPasteboard.general.string = csv
            engine.statusMessage = "CSV copied (\(csv.components(separatedBy: "\n").count - 1) rows)"
        } else {
            engine.statusMessage = "No snapshots cached for \(sym)"
        }
    }

    private func exportSnapshotCSV(symbol: String) -> String? {
        guard let snapshots = SnapshotCache.load(symbol: symbol, timeframe: "daily_4h"),
              !snapshots.isEmpty else { return nil }

        let header = [
            "timestamp", "price", "timeframe", "isCrypto",
            "rsi", "macdHist", "macdHistAboveDeadZone",
            "adxValue", "adxBullish",
            "emaCrossCount", "ema20Rising", "stackBullish", "stackBearish",
            "structureBullish", "structureBearish", "aboveVwap",
            "stochK", "divergenceBullish", "divergenceBearish",
            "last3Green", "last3Red", "last3VolIncreasing",
            "crossAssetSignal", "volScalar",
            "derivativesCombined", "fundingSignal", "oiSignal", "takerSignal", "crowdingSignal",
            "vix", "dxyAboveEma20",
            "obvRising", "adLineAccumulation",
            "atrPercent",
            "priceAfter4H", "priceAfter24H", "forwardHigh24H", "forwardLow24H"
        ].joined(separator: ",")

        var csv = header + "\n"
        for s in snapshots {
            let row = [
                "\(Int(s.timestamp.timeIntervalSince1970))",
                "\(s.price)", s.timeframe, "\(s.isCrypto ? 1 : 0)",
                "\(s.rsi ?? 50)", "\(s.macdHistogram)", "\(s.macdHistAboveDeadZone ? 1 : 0)",
                "\(s.adxValue)", "\(s.adxBullish ? 1 : 0)",
                "\(s.emaCrossCount)", "\(s.ema20Rising ? 1 : 0)",
                "\(s.stackBullish ? 1 : 0)", "\(s.stackBearish ? 1 : 0)",
                "\(s.structureBullish ? 1 : 0)", "\(s.structureBearish ? 1 : 0)",
                "\(s.aboveVwap ? 1 : 0)",
                "\(s.stochK ?? 50)",
                "\(s.divergence == "bullish" ? 1 : 0)", "\(s.divergence == "bearish" ? 1 : 0)",
                "\(s.last3Green ? 1 : 0)", "\(s.last3Red ? 1 : 0)", "\(s.last3VolIncreasing ? 1 : 0)",
                "\(s.crossAssetSignal)", String(format: "%.2f", s.volScalar),
                "\(s.derivativesCombinedSignal)", "\(s.fundingSignal)",
                "\(s.oiSignal)", "\(s.takerSignal)", "\(s.crowdingSignal)",
                "\(s.vix ?? 0)", "\(s.dxyAboveEma20 == true ? 1 : 0)",
                "\(s.obvRising ? 1 : 0)", "\(s.adLineAccumulation ? 1 : 0)",
                "\(s.atrPercent ?? 0)",
                "\(s.priceAfter4H ?? 0)", "\(s.priceAfter24H ?? 0)",
                "\(s.forwardHigh24H ?? 0)", "\(s.forwardLow24H ?? 0)"
            ].joined(separator: ",")
            csv += row + "\n"
        }
        return csv
    }

    private func shareText() -> String {
        guard let best = engine.bestResult else { return "" }
        let f = { (v: Double) in String(format: "%.1f%%", v) }
        var text = """
        MarketScope Optimizer — \(market == .crypto ? "Crypto" : "Stocks")
        Assets: \(symbols.joined(separator: ", "))
        \(startDate.formatted(date: .abbreviated, time: .omitted)) → \(endDate.formatted(date: .abbreviated, time: .omitted))

        Winner: \(best.params.label)
        Train Opp: \(f(best.avgTrainOpp)) | Valid Opp: \(f(best.avgValidOpp))
        Worst Train: \(f(best.worstTrainOpp)) | Worst Valid: \(f(best.worstValidOpp))
        Gap: \(f(best.gap))

        Parameters:
        PP=\(best.params.pricePositionWeight) ES=\(best.params.emaSlopeWeight) ST=\(best.params.structureWeight) SC=\(best.params.stackConfirmWeight)
        ADX=\(best.params.adxWeakWeight)/\(best.params.adxModWeight)/\(best.params.adxStrongWeight) RSI=\(best.params.rsiWeight) MACD=\(best.params.macdMaxWeight)
        Daily: Dir \(best.params.dailyDirectionalThreshold) / Strong \(best.params.dailyStrongThreshold)
        4H: Dir \(best.params.fourHDirectionalThreshold) / Strong \(best.params.fourHStrongThreshold)
        """

        let allMetrics = best.trainMetrics + best.validMetrics
        if !allMetrics.isEmpty {
            text += "\n\nPer-Asset:"
            for m in best.validMetrics {
                text += "\n\(m.symbol): Opp \(f(m.opportunityRate)) | Acc \(f(m.accuracy24H)) | \(m.directionalBars)/\(m.totalBars) bars"
            }
        }
        return text
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
