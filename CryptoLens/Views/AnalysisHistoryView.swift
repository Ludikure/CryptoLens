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
                            history.remove(atOffsets: offsets)
                            Task {
                                for id in ids {
                                    await AnalysisHistoryStore.deleteAsync(symbol: symbol, id: id)
                                }
                            }
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

            // Regime + Self-Check quality
            HStack(spacing: 6) {
                if let regime = extractRegime(from: result.claudeAnalysis) {
                    Text(regime)
                        .font(.caption2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(regimeColor(regime).opacity(0.15))
                        .foregroundStyle(regimeColor(regime))
                        .clipShape(Capsule())
                }
                let qc = Self.parseSelfCheck(from: result.claudeAnalysis)
                if qc.quality != .unavailable {
                    Label(qc.shortLabel, systemImage: qc.icon)
                        .font(.caption2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(qc.color.opacity(0.15))
                        .foregroundStyle(qc.color)
                        .clipShape(Capsule())
                }
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

    private func regimeColor(_ regime: String) -> Color {
        let r = regime.lowercased()
        if r.contains("trending up") || r.contains("bullish") { return .green }
        if r.contains("trending down") || r.contains("bearish") { return .red }
        if r.contains("ranging") || r.contains("consolidat") { return .orange }
        if r.contains("breakout") { return .blue }
        return .secondary
    }

    /// Parsed Self-Check section. Counts Y / N / NA tags and classifies the analysis
    /// as allPass / oneIssue / multipleIssues / unavailable. Used for the badge.
    struct SelfCheckResult {
        let yesCount: Int
        let noCount: Int
        let naCount: Int
        let quality: Quality

        enum Quality { case allPass, oneIssue, multipleIssues, unavailable }

        var shortLabel: String {
            switch quality {
            case .allPass: return "All checks pass"
            case .oneIssue: return "1 issue"
            case .multipleIssues: return "\(noCount) issues"
            case .unavailable: return ""
            }
        }
        var icon: String {
            switch quality {
            case .allPass: return "checkmark.seal.fill"
            case .oneIssue: return "exclamationmark.triangle.fill"
            case .multipleIssues: return "xmark.octagon.fill"
            case .unavailable: return ""
            }
        }
        var color: Color {
            switch quality {
            case .allPass: return .green
            case .oneIssue: return .orange
            case .multipleIssues: return .red
            case .unavailable: return .secondary
            }
        }
    }

    /// Walk the markdown looking for the `## Self-Check` section. Inside, every line
    /// with a colon-followed-by-Y/N/NA token contributes to the counts. Tolerant of
    /// minor formatting drift (bullet/no-bullet, parens/no-parens after the tag).
    static func parseSelfCheck(from markdown: String) -> SelfCheckResult {
        let lines = markdown.components(separatedBy: "\n")
        var inSection = false
        var yes = 0, no = 0, na = 0
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.lowercased().hasPrefix("## self-check") {
                inSection = true; continue
            }
            if inSection && line.hasPrefix("## ") { break }
            if !inSection { continue }
            // Look for "...: <tag> ..." where <tag> is Y / N / NA. Be tolerant of
            // a leading bullet or numbering. Skip the introductory sentence (no colon).
            guard let colonIdx = line.firstIndex(of: ":") else { continue }
            let after = line[line.index(after: colonIdx)...].trimmingCharacters(in: .whitespaces)
            // Match the first whitespace-separated token after the colon
            let firstToken = after.split(whereSeparator: { $0.isWhitespace || $0 == "(" }).first.map(String.init) ?? ""
            let token = firstToken.uppercased()
            if token == "NA" || token == "N/A" { na += 1 }
            else if token == "Y" || token == "YES" { yes += 1 }
            else if token == "N" || token == "NO" { no += 1 }
        }
        if yes + no + na == 0 {
            return SelfCheckResult(yesCount: 0, noCount: 0, naCount: 0, quality: .unavailable)
        }
        let q: SelfCheckResult.Quality
        if no == 0 { q = .allPass }
        else if no == 1 { q = .oneIssue }
        else { q = .multipleIssues }
        return SelfCheckResult(yesCount: yes, noCount: no, naCount: na, quality: q)
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
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: shareText) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
    }

    /// Plain-text representation of the historical analysis. Mirrors the share format
    /// used on the live analysis screen (ContentView.shareText) so a screenshot/share
    /// from "now" and a share from history both look the same to the recipient.
    private var shareText: String {
        var text = """
        \(result.symbol) Analysis — \(result.timestamp.formatted(date: .abbreviated, time: .shortened))

        Price then: \(Formatters.formatPrice(result.daily.price))
        """
        if let current = currentPrice {
            let change = ((current - result.daily.price) / result.daily.price) * 100
            text += "\nPrice now: \(Formatters.formatPrice(current)) (\(String(format: "%+.1f%%", change)))"
        }
        text += "\nBias: \(result.daily.bias) (D) | \(result.h4.bias) (4H) | \(result.h1.bias) (1H)"
        if let setup = result.tradeSetups.first {
            text += "\n\nTrade Setup: \(setup.direction) @ \(Formatters.formatPrice(setup.entry))"
            text += "\nSL: \(Formatters.formatPrice(setup.stopLoss))  TP1: \(Formatters.formatPrice(setup.tp1))"
            if let tp2 = setup.tp2 { text += "  TP2: \(Formatters.formatPrice(tp2))" }
            text += "\nR:R \(String(format: "%.1f", setup.rrTP1))"
        }
        if !result.claudeAnalysis.isEmpty {
            text += "\n\n--- AI Analysis ---\n\n\(result.claudeAnalysis)"
        }
        text += "\n\nGenerated by MarketScope"
        return text
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

}
