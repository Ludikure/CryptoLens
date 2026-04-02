import SwiftUI

struct AnalysisHistoryView: View {
    let symbol: String
    let currentPrice: Double?
    @State private var history: [AnalysisResult] = []
    @State private var selectedResult: AnalysisResult?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if history.isEmpty {
                    ContentUnavailableView(
                        "No History",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Run an AI analysis to start building history.")
                    )
                } else {
                    List {
                        ForEach(history) { result in
                            Button {
                                selectedResult = result
                            } label: {
                                historyRow(result)
                            }
                            .buttonStyle(.plain)
                        }
                        .onDelete { offsets in
                            let ids = offsets.map { history[$0].id }
                            for id in ids {
                                AnalysisHistoryStore.delete(symbol: symbol, id: id)
                            }
                            history.remove(atOffsets: offsets)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Analysis History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $selectedResult) { result in
                HistoryDetailView(result: result, currentPrice: currentPrice)
            }
            .onAppear {
                history = AnalysisHistoryStore.load(symbol: symbol)
            }
        }
    }

    private func historyRow(_ result: AnalysisResult) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(result.timestamp.formatted(date: .abbreviated, time: .shortened))
                    .font(.subheadline)
                    .fontWeight(.medium)
                Spacer()
                Text(timeAgo(result.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            HStack(spacing: 8) {
                // Price at analysis
                Text(Formatters.formatPrice(result.daily.price))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Price change since analysis
                if let current = currentPrice {
                    let change = ((current - result.daily.price) / result.daily.price) * 100
                    Text(String(format: "%+.1f%%", change))
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }

                Spacer()

                // Bias badges
                HStack(spacing: 4) {
                    biasBadge("D", result.tf1.bias)
                    biasBadge("4H", result.tf2.bias)
                    biasBadge("1H", result.tf3.bias)
                }
            }

            // Regime from analysis
            if let regime = extractRegime(from: result.claudeAnalysis) {
                Text(regime)
                    .font(.caption2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(regimeColor(regime).opacity(0.15))
                    .foregroundStyle(regimeColor(regime))
                    .clipShape(Capsule())
            }

            // Trade setup summary
            if let setup = result.tradeSetups.first {
                HStack(spacing: 4) {
                    Image(systemName: setup.direction == "LONG" ? "arrow.up.right" : "arrow.down.right")
                        .font(.caption2)
                        .foregroundStyle(setup.direction == "LONG" ? .green : .red)
                    Text("\(setup.direction) @ \(Formatters.formatPrice(setup.entry))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("R:R \(String(format: "%.1f", setup.rrTP1))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func biasBadge(_ label: String, _ bias: String) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(biasColor(bias).opacity(0.2))
            .foregroundStyle(biasColor(bias))
            .clipShape(Capsule())
    }

    private func biasColor(_ bias: String) -> Color {
        if bias.contains("Strong Bull") { return .green }
        if bias.contains("Bull") { return .green.opacity(0.7) }
        if bias.contains("Strong Bear") { return .red }
        if bias.contains("Bear") { return .red.opacity(0.7) }
        return .secondary
    }

    private func regimeColor(_ regime: String) -> Color {
        let r = regime.lowercased()
        if r.contains("trending up") || r.contains("bullish") { return .green }
        if r.contains("trending down") || r.contains("bearish") { return .red }
        if r.contains("ranging") || r.contains("consolidat") { return .orange }
        if r.contains("breakout") { return .blue }
        return .secondary
    }

    private func extractRegime(from markdown: String) -> String? {
        // Look for "## Market Regime" section
        let lines = markdown.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            if line.contains("Market Regime") || line.contains("REGIME") {
                // Get the next non-empty line as the regime description
                for j in (i+1)..<min(i+4, lines.count) {
                    let candidate = lines[j].trimmingCharacters(in: .whitespaces)
                    if !candidate.isEmpty && !candidate.starts(with: "#") && !candidate.starts(with: "---") {
                        // Clean up markdown formatting
                        return candidate
                            .replacingOccurrences(of: "**", with: "")
                            .replacingOccurrences(of: "*", with: "")
                            .trimmingCharacters(in: .whitespaces)
                    }
                }
            }
        }
        return nil
    }

    private func timeAgo(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}

// MARK: - Detail View

struct HistoryDetailView: View {
    let result: AnalysisResult
    let currentPrice: Double?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Header
                    headerSection

                    Divider()

                    // Bias at time of analysis
                    biasSection

                    Divider()

                    // Trade setup
                    if let setup = result.tradeSetups.first {
                        setupSection(setup)
                        Divider()
                    }

                    // Full AI analysis
                    if !result.claudeAnalysis.isEmpty {
                        Text("AI Analysis")
                            .font(.headline)
                        ClaudeAnalysisView(
                            markdown: result.claudeAnalysis,
                            aiLoadingPhase: .idle,
                            isStale: false,
                            onRunAnalysis: {}
                        )
                    }
                }
                .padding()
            }
            .navigationTitle(result.timestamp.formatted(date: .abbreviated, time: .shortened))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(Constants.asset(for: result.symbol)?.name ?? result.symbol)
                    .font(.title2)
                    .fontWeight(.bold)
                Spacer()
                Text(timeAgo(result.timestamp))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            HStack(spacing: 16) {
                VStack(alignment: .leading) {
                    Text("Price then")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(Formatters.formatPrice(result.daily.price))
                        .font(.title3)
                        .fontWeight(.semibold)
                }
                if let current = currentPrice {
                    VStack(alignment: .leading) {
                        Text("Price now")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(Formatters.formatPrice(current))
                            .font(.title3)
                            .fontWeight(.semibold)
                    }
                    let change = ((current - result.daily.price) / result.daily.price) * 100
                    VStack(alignment: .leading) {
                        Text("Change")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(String(format: "%+.1f%%", change))
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundStyle(change >= 0 ? .green : .red)
                    }
                }
            }
        }
    }

    private var biasSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Bias Snapshot")
                .font(.headline)
            HStack(spacing: 12) {
                biasCard("Daily", result.tf1.bias)
                biasCard("4H", result.tf2.bias)
                biasCard("1H", result.tf3.bias)
            }
        }
    }

    private func biasCard(_ label: String, _ bias: String) -> some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(bias)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(biasColor(bias))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(biasColor(bias).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func setupSection(_ setup: TradeSetup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Trade Setup")
                    .font(.headline)
                Spacer()
                Text(setup.direction)
                    .font(.caption)
                    .fontWeight(.bold)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(setup.direction == "LONG" ? Color.green.opacity(0.2) : Color.red.opacity(0.2))
                    .foregroundStyle(setup.direction == "LONG" ? .green : .red)
                    .clipShape(Capsule())
            }

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    Text("Entry").font(.caption).foregroundStyle(.secondary)
                    Text(Formatters.formatPrice(setup.entry)).font(.caption).fontWeight(.medium)
                }
                GridRow {
                    Text("Stop Loss").font(.caption).foregroundStyle(.secondary)
                    Text(Formatters.formatPrice(setup.stopLoss)).font(.caption).fontWeight(.medium).foregroundStyle(.red)
                }
                GridRow {
                    Text("TP1").font(.caption).foregroundStyle(.secondary)
                    Text(Formatters.formatPrice(setup.tp1)).font(.caption).fontWeight(.medium).foregroundStyle(.green)
                }
                if let tp2 = setup.tp2 {
                    GridRow {
                        Text("TP2").font(.caption).foregroundStyle(.secondary)
                        Text(Formatters.formatPrice(tp2)).font(.caption).fontWeight(.medium).foregroundStyle(.green)
                    }
                }
                GridRow {
                    Text("R:R").font(.caption).foregroundStyle(.secondary)
                    Text(String(format: "%.1f", setup.rrTP1)).font(.caption).fontWeight(.bold)
                }
            }

            // Show if setup would have worked
            if let current = currentPrice {
                let hitTP1 = setup.direction == "LONG" ? current >= setup.tp1 : current <= setup.tp1
                let hitSL = setup.direction == "LONG" ? current <= setup.stopLoss : current >= setup.stopLoss
                if hitTP1 {
                    Label("TP1 reached", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else if hitSL {
                    Label("Stop loss hit", systemImage: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Label("Still in play", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private func biasColor(_ bias: String) -> Color {
        if bias.contains("Strong Bull") { return .green }
        if bias.contains("Bull") { return .green.opacity(0.7) }
        if bias.contains("Strong Bear") { return .red }
        if bias.contains("Bear") { return .red.opacity(0.7) }
        return .secondary
    }

    private func timeAgo(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}
