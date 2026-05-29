import SwiftUI

/// Dashboard showing trade outcome statistics: win rate, R:R, kill save rate, false FLAT rate.
struct OutcomeDashboardView: View {
    @EnvironmentObject var service: AnalysisService
    @State private var stats: OutcomeStats?
    @State private var liveSetups: [TrackedSetup] = []
    @State private var versionComparison: [String: VersionStats] = [:]

    var body: some View {
        List {
            if let stats {
                // Live trades
                if !liveSetups.isEmpty {
                    Section("Live Trades") {
                        ForEach(liveSetups, id: \.id) { tracked in
                            if tracked.outcome.state == .pending {
                                pendingTradeRow(tracked)
                            } else {
                                liveTradeRow(tracked)
                            }
                        }
                    }
                }

                // A/B comparison — baseline vs treatment slice of the same archive
                if hasABData {
                    abSection
                }

                // Setup performance — generated vs counted
                Section("Trade Setups") {
                    statRow("Generated", value: "\(stats.generatedSetups)")
                    statRow("Counted", value: "\(stats.countedSetups)",
                            color: .primary)
                    statRow("Resolved", value: "\(stats.resolvedSetups)")
                    statRow("Win Rate", value: String(format: "%.0f%%", stats.winRate),
                            color: stats.winRate >= 50 ? .green : .red)
                    statRow("Wins / Losses", value: "\(stats.wins) / \(stats.losses)")
                    if stats.partialBE > 0 {
                        statRow("Partial BE", value: "\(stats.partialBE)",
                                color: .orange)
                    }
                    statRow("Avg R:R Achieved", value: String(format: "%.1f", stats.avgRRAchieved),
                            color: stats.avgRRAchieved >= 1.5 ? .green : .orange)
                }

                // Setup filtering (pending/invalidated/expired)
                if stats.pendingSetups > 0 || stats.invalidatedSetups > 0 || stats.expiredSetups > 0 {
                    Section("Setup Filtering") {
                        if stats.pendingSetups > 0 {
                            statRow("Pending", value: "\(stats.pendingSetups)",
                                    color: .blue)
                        }
                        if stats.invalidatedSetups > 0 {
                            statRow("Invalidated", value: "\(stats.invalidatedSetups)",
                                    color: .orange)
                            // Breakdown by reason
                            ForEach(stats.invalidReasons.sorted(by: { $0.value > $1.value }), id: \.key) { reason, count in
                                HStack {
                                    Text("  \(reasonLabel(reason))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text("\(count)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        if stats.expiredSetups > 0 {
                            statRow("Expired (12h timeout)", value: "\(stats.expiredSetups)",
                                    color: .secondary)
                        }
                    }
                }

                // FLAT/Kill tracking
                Section("FLAT / Kill Decisions") {
                    statRow("Total FLAT/Kill", value: "\(stats.totalFlats)")
                    statRow("Evaluated", value: "\(stats.evaluatedFlats)")
                    statRow("False FLATs", value: "\(stats.falseFlats)",
                            color: stats.falseFlatRate > 30 ? .red : .green)
                    statRow("False FLAT Rate", value: String(format: "%.0f%%", stats.falseFlatRate),
                            color: stats.falseFlatRate > 30 ? .red : .green)
                }

                // Recent setups
                if !stats.recentSetups.isEmpty {
                    Section("Recent Setups") {
                        ForEach(stats.recentSetups) { tracked in
                            recentSetupRow(tracked)
                        }
                    }
                }
            } else {
                ProgressView("Loading stats...")
            }
        }
        .navigationTitle("Outcome Tracking")
        .task {
            stats = OutcomeTracker.stats()
            versionComparison = OutcomeTracker.versionStats()
            loadLiveSetups()
        }
        .refreshable {
            stats = OutcomeTracker.stats()
            versionComparison = OutcomeTracker.versionStats()
            loadLiveSetups()
        }
        .toolbar {
            if let s = stats {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = shareText(s)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    ShareLink(item: shareText(s), preview: SharePreview("Outcome Tracking"))
                }
            }
        }
    }

    // MARK: - A/B comparison

    private var hasABData: Bool {
        let b = versionComparison[OutcomeTracker.baselinePromptVersion]
        let t = versionComparison[OutcomeTracker.treatmentPromptVersion]
        return (b?.countedSetups ?? 0) + (t?.countedSetups ?? 0) > 0
    }

    @ViewBuilder
    private var abSection: some View {
        let baseline = versionComparison[OutcomeTracker.baselinePromptVersion]
        let treatment = versionComparison[OutcomeTracker.treatmentPromptVersion]

        Section {
            // Header row
            HStack {
                Text("").frame(maxWidth: .infinity, alignment: .leading)
                Text("Baseline")
                    .font(.caption2).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .frame(width: 80, alignment: .trailing)
                Text("Treatment")
                    .font(.caption2).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .frame(width: 80, alignment: .trailing)
            }
            abMetricRow("Counted", baseline?.countedSetups, treatment?.countedSetups)
            abMetricRow("Resolved", baseline?.resolvedSetups, treatment?.resolvedSetups)
            abMetricRow("Wins / Losses",
                        baselineText: pairText(baseline?.wins, baseline?.losses),
                        treatmentText: pairText(treatment?.wins, treatment?.losses))
            abMetricRow("Win Rate",
                        baselineText: percentText(baseline?.winRate, samples: baseline?.resolvedSetups),
                        treatmentText: percentText(treatment?.winRate, samples: treatment?.resolvedSetups),
                        baselineColor: rateColor(baseline?.winRate, samples: baseline?.resolvedSetups),
                        treatmentColor: rateColor(treatment?.winRate, samples: treatment?.resolvedSetups))
            abMetricRow("Avg R Achieved",
                        baselineText: rrText(baseline?.avgRRAchieved, samples: baseline?.resolvedSetups),
                        treatmentText: rrText(treatment?.avgRRAchieved, samples: treatment?.resolvedSetups))

            // Significance verdict (only when both sides have enough samples)
            if let verdict = significanceVerdict(baseline: baseline, treatment: treatment) {
                HStack {
                    Image(systemName: verdict.icon)
                        .foregroundStyle(verdict.color)
                    Text(verdict.label)
                        .font(.caption)
                        .foregroundStyle(verdict.color)
                }
            }
        } header: {
            HStack {
                Text("A/B: Prompt Version (30d)")
                Spacer()
            }
        } footer: {
            Text("Setups split deterministically by (device, day). Counted = entry triggered; Resolved = terminal state reached.")
                .font(.caption2)
        }
    }

    private func abMetricRow(_ label: String, _ baselineVal: Int?, _ treatmentVal: Int?) -> some View {
        abMetricRow(label,
                    baselineText: baselineVal.map { "\($0)" } ?? "—",
                    treatmentText: treatmentVal.map { "\($0)" } ?? "—")
    }

    private func abMetricRow(_ label: String,
                              baselineText: String, treatmentText: String,
                              baselineColor: Color = .primary, treatmentColor: Color = .primary) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(baselineText).fontWeight(.semibold).foregroundStyle(baselineColor)
                .frame(width: 80, alignment: .trailing)
            Text(treatmentText).fontWeight(.semibold).foregroundStyle(treatmentColor)
                .frame(width: 80, alignment: .trailing)
        }
        .font(.subheadline)
    }

    private func pairText(_ a: Int?, _ b: Int?) -> String {
        guard a != nil || b != nil else { return "—" }
        return "\(a ?? 0)/\(b ?? 0)"
    }

    private func percentText(_ rate: Double?, samples: Int?) -> String {
        guard let rate, let samples, samples > 0 else { return "—" }
        return String(format: "%.0f%%", rate)
    }

    private func rrText(_ rr: Double?, samples: Int?) -> String {
        guard let rr, let samples, samples > 0 else { return "—" }
        return String(format: "%.2fR", rr)
    }

    private func rateColor(_ rate: Double?, samples: Int?) -> Color {
        guard let rate, let samples, samples >= 10 else { return .secondary }
        return rate >= 50 ? .green : .red
    }

    private struct ABVerdict {
        let label: String
        let color: Color
        let icon: String
    }

    /// 2x2 chi-square on (wins/losses, baseline/treatment). Requires both sides to
    /// have >= 30 resolved setups for the test to be meaningful. p < 0.05 ↔ chi² > 3.841.
    private func significanceVerdict(baseline: VersionStats?, treatment: VersionStats?) -> ABVerdict? {
        guard let b = baseline, let t = treatment else { return nil }
        let a = Double(b.wins), c = Double(b.losses)
        let d = Double(t.wins), e = Double(t.losses)
        let nBaseline = b.resolvedSetups, nTreatment = t.resolvedSetups
        if nBaseline < 30 || nTreatment < 30 {
            return ABVerdict(label: "Need ≥30 resolved per side for significance (\(nBaseline)/\(nTreatment) so far)",
                              color: .secondary, icon: "hourglass")
        }
        let n = a + c + d + e
        let denom = (a + c) * (d + e) * (a + d) * (c + e)
        guard denom > 0 else {
            return ABVerdict(label: "Insufficient variance to test", color: .secondary, icon: "minus.circle")
        }
        let chi2 = pow((a * e - c * d), 2) * n / denom
        let treatmentBetter = (t.winRate > b.winRate)
        if chi2 > 3.841 {
            return ABVerdict(label: treatmentBetter
                                ? "Treatment wins (p < 0.05)"
                                : "Baseline wins (p < 0.05)",
                              color: treatmentBetter ? .green : .red,
                              icon: "checkmark.circle.fill")
        } else {
            return ABVerdict(label: "Not significant (χ² = \(String(format: "%.2f", chi2)))",
                              color: .secondary, icon: "equal.circle")
        }
    }

    private func statRow(_ label: String, value: String, color: Color = .primary) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.semibold).foregroundStyle(color)
        }
        .font(.subheadline)
    }

    private func reasonLabel(_ key: String) -> String {
        switch key {
        case "direction": return "Direction changed"
        case "ml_drift": return "ML score dropped"
        case "kills": return "Kill conditions"
        case "no_data": return "No cached data"
        case "flat": return "Analysis went FLAT"
        default: return key.capitalized
        }
    }

    private func recentSetupRow(_ tracked: TrackedSetup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(tracked.symbol).font(.caption).fontWeight(.bold)
                Text(tracked.setup.direction)
                    .font(.caption2).fontWeight(.bold)
                    .foregroundStyle(tracked.setup.direction == "LONG" ? .green : .red)
                if tracked.setupType == .conditional {
                    Text("COND")
                        .font(.system(size: 8, weight: .bold))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .foregroundStyle(.purple)
                        .background(Color.purple.opacity(0.15), in: Capsule())
                }
                Spacer()
                Text(tracked.outcome.result)
                    .font(.caption2).fontWeight(.semibold)
                    .foregroundStyle(outcomeColor(tracked.outcome.result))
            }

            // Show invalidation reason if applicable
            if tracked.outcome.state == .invalidated,
               let reason = tracked.outcome.reEvalResult?.reason {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            HStack(spacing: 12) {
                Text("Entry: \(Formatters.formatPrice(tracked.setup.entry))")
                Text("SL: \(Formatters.formatPrice(tracked.setup.stopLoss))")
                Text("TP1: \(Formatters.formatPrice(tracked.setup.tp1))")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            if tracked.outcome.entryHit {
                HStack(spacing: 12) {
                    Text("Max Fav: \(Formatters.formatPrice(tracked.outcome.maxFavorable))")
                        .foregroundStyle(.green)
                    Text("Max Adv: \(Formatters.formatPrice(tracked.outcome.maxAdverse))")
                        .foregroundStyle(.red)
                }
                .font(.caption2)
            }

            Text(tracked.timestamp, format: .dateTime.month(.abbreviated).day().hour().minute())
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }

    private func loadLiveSetups() {
        var live = [TrackedSetup]()
        for sym in service.resultsBySymbol.keys {
            live.append(contentsOf: OutcomeTracker.activeSetups(symbol: sym))
        }
        liveSetups = live.sorted { $0.timestamp > $1.timestamp }
    }

    private func pendingTradeRow(_ tracked: TrackedSetup) -> some View {
        let currentPrice = service.resultsBySymbol[tracked.symbol]?.tf1.price ?? tracked.setup.entry
        let distToEntry = abs(tracked.setup.entry - currentPrice)
        let timeRemaining: String = {
            guard let expires = tracked.outcome.pendingExpiresAt else { return "" }
            let remaining = expires.timeIntervalSinceNow
            if remaining <= 0 { return "expiring" }
            let hours = Int(remaining / 3600)
            let mins = Int((remaining.truncatingRemainder(dividingBy: 3600)) / 60)
            return hours > 0 ? "\(hours)h \(mins)m" : "\(mins)m"
        }()

        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(tracked.symbol).font(.caption).fontWeight(.bold)
                Text(tracked.setup.direction)
                    .font(.caption2).fontWeight(.bold)
                    .foregroundStyle(tracked.setup.direction == "LONG" ? .green : .red)
                Text("PENDING")
                    .font(.system(size: 8, weight: .bold))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .foregroundStyle(.blue)
                    .background(Color.blue.opacity(0.2), in: Capsule())
                Spacer()
                if !timeRemaining.isEmpty {
                    Text(timeRemaining)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 12) {
                Text("Entry: \(Formatters.formatPrice(tracked.setup.entry))")
                Text("\(Formatters.formatPrice(distToEntry)) away")
                    .foregroundStyle(.secondary)
            }
            .font(.caption2)
        }
        .padding(.vertical, 2)
    }

    private func liveTradeRow(_ tracked: TrackedSetup) -> some View {
        let currentPrice = service.resultsBySymbol[tracked.symbol]?.tf1.price ?? tracked.setup.entry
        let isLong = tracked.setup.direction == "LONG"
        let pnl = isLong
            ? (currentPrice - tracked.setup.entry) / tracked.setup.entry * 100
            : (tracked.setup.entry - currentPrice) / tracked.setup.entry * 100
        let nextTarget = tracked.outcome.tp1Hit ? (tracked.setup.tp2 ?? tracked.setup.tp1) : tracked.setup.tp1
        let distToTarget = abs(nextTarget - currentPrice)
        let targetLabel = tracked.outcome.tp1Hit ? "TP2" : "TP1"
        let held = Int(Date().timeIntervalSince(tracked.outcome.entryHitTime ?? tracked.timestamp) / 3600)
        let maxFav = tracked.outcome.maxFavorable
        let maxAdv = tracked.outcome.maxAdverse

        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(tracked.symbol).font(.caption).fontWeight(.bold)
                Text(tracked.setup.direction)
                    .font(.caption2).fontWeight(.bold)
                    .foregroundStyle(isLong ? .green : .red)
                Spacer()
                Text(String(format: "%+.1f%%", pnl))
                    .font(.caption.bold())
                    .foregroundStyle(pnl >= 0 ? .green : .red)
            }
            HStack(spacing: 12) {
                Text("Entry: \(Formatters.formatPrice(tracked.setup.entry))")
                Text("Now: \(Formatters.formatPrice(currentPrice))")
                    .foregroundStyle(pnl >= 0 ? .green : .red)
            }
            .font(.caption2)
            HStack(spacing: 12) {
                Text("\(targetLabel) \(Formatters.formatPrice(distToTarget)) away")
                    .foregroundStyle(.secondary)
                Text("\(held)h held")
                    .foregroundStyle(.secondary)
                Text("MaxFav: \(Formatters.formatPrice(maxFav))")
                    .foregroundStyle(.green)
                Text("MaxAdv: \(Formatters.formatPrice(maxAdv))")
                    .foregroundStyle(.red)
            }
            .font(.caption2)
            // Management status
            if tracked.outcome.breakevenActivated {
                HStack(spacing: 6) {
                    Image(systemName: tracked.outcome.partialTaken ? "checkmark.circle.fill" : "shield.fill")
                        .foregroundStyle(.orange)
                    Text(tracked.outcome.managementStatus)
                        .foregroundStyle(.orange)
                }
                .font(.caption2)
            }
        }
        .padding(.vertical, 2)
    }

    private func shareText(_ s: OutcomeStats) -> String {
        let summary = """
        MarketScope Outcome Tracking

        Trade Setups:
        \u{2022} Generated: \(s.generatedSetups) | Counted: \(s.countedSetups)
        \u{2022} Resolved: \(s.resolvedSetups) | Win Rate: \(String(format: "%.0f%%", s.winRate))
        \u{2022} Wins: \(s.wins) | Losses: \(s.losses)\(s.partialBE > 0 ? " | Partial BE: \(s.partialBE)" : "")
        \u{2022} Avg R:R Achieved: \(String(format: "%.1f", s.avgRRAchieved))
        \u{2022} Invalidated: \(s.invalidatedSetups) | Expired: \(s.expiredSetups)

        FLAT / Kill Decisions:
        \u{2022} Total: \(s.totalFlats) | Evaluated: \(s.evaluatedFlats)
        \u{2022} False FLATs: \(s.falseFlats) (\(String(format: "%.0f%%", s.falseFlatRate)))
        """

        let liveBlock: String = liveSetups.isEmpty ? "" : """


        Live Trades (\(liveSetups.count)):
        \(liveSetups.map { formatSetupLine($0) }.joined(separator: "\n"))
        """

        let allHistorical = OutcomeTracker.allSetups().filter { ts in
            // Anything not currently live: resolved, invalidated, expired, or active-but-counted.
            !liveSetups.contains(where: { $0.id == ts.id })
        }
        let historyBlock: String = allHistorical.isEmpty ? "" : """


        Trade Outcomes (\(allHistorical.count)):
        \(allHistorical.map { formatSetupLine($0) }.joined(separator: "\n"))
        """

        return summary + liveBlock + historyBlock
    }

    /// Single-line formatter mirroring the row layout — symbol/dir/tag, prices, fav/adv,
    /// outcome label, timestamp. Stays compact so a long share doesn't exceed paste limits.
    private func formatSetupLine(_ t: TrackedSetup) -> String {
        let date = t.timestamp.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        let dir = t.setup.direction
        let cond = t.setupType == .conditional ? " COND" : ""
        let entry = Formatters.formatPrice(t.setup.entry)
        let sl = Formatters.formatPrice(t.setup.stopLoss)
        let tp1 = Formatters.formatPrice(t.setup.tp1)
        var line = "\(date) \(t.symbol) \(dir)\(cond) — \(t.outcome.result) | E:\(entry) SL:\(sl) TP1:\(tp1)"
        if t.outcome.entryHit {
            line += " | MaxFav:\(Formatters.formatPrice(t.outcome.maxFavorable)) MaxAdv:\(Formatters.formatPrice(t.outcome.maxAdverse))"
        }
        if t.outcome.state == .invalidated, let reason = t.outcome.reEvalResult?.reason {
            line += " (\(reason))"
        }
        return line
    }

    private func outcomeColor(_ result: String) -> Color {
        switch result {
        case "tp1_win", "tp2_win": return .green
        case "partial_be": return .orange
        case "invalidated": return .orange
        case "expired", "pending": return .secondary
        case "loss": return .red
        case "open": return .blue
        default: return .secondary
        }
    }
}
