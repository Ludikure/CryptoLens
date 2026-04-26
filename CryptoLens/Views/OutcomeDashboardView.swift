import SwiftUI

/// Dashboard showing trade outcome statistics: win rate, R:R, kill save rate, false FLAT rate.
struct OutcomeDashboardView: View {
    @EnvironmentObject var service: AnalysisService
    @State private var stats: OutcomeStats?
    @State private var liveSetups: [TrackedSetup] = []

    var body: some View {
        List {
            if let stats {
                // Live trades
                if !liveSetups.isEmpty {
                    Section("Live Trades") {
                        ForEach(liveSetups, id: \.id) { tracked in
                            liveTradeRow(tracked)
                        }
                    }
                }

                // Setup performance
                Section("Trade Setups") {
                    statRow("Total Generated", value: "\(stats.totalSetups)")
                    statRow("Resolved", value: "\(stats.resolvedSetups)")
                    statRow("Win Rate", value: String(format: "%.0f%%", stats.winRate),
                            color: stats.winRate >= 50 ? .green : .red)
                    statRow("Wins / Losses", value: "\(stats.wins) / \(stats.losses)")
                    statRow("Avg R:R Achieved", value: String(format: "%.1f", stats.avgRRAchieved),
                            color: stats.avgRRAchieved >= 1.5 ? .green : .orange)
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
            loadLiveSetups()
        }
        .refreshable {
            stats = OutcomeTracker.stats()
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

    private func statRow(_ label: String, value: String, color: Color = .primary) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.semibold).foregroundStyle(color)
        }
        .font(.subheadline)
    }

    private func recentSetupRow(_ tracked: TrackedSetup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(tracked.symbol).font(.caption).fontWeight(.bold)
                Text(tracked.setup.direction)
                    .font(.caption2).fontWeight(.bold)
                    .foregroundStyle(tracked.setup.direction == "LONG" ? .green : .red)
                Spacer()
                Text(tracked.outcome.result)
                    .font(.caption2).fontWeight(.semibold)
                    .foregroundStyle(outcomeColor(tracked.outcome.result))
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
        }
        .padding(.vertical, 2)
    }

    private func shareText(_ s: OutcomeStats) -> String {
        """
        MarketScope Outcome Tracking

        Trade Setups:
        • Total: \(s.totalSetups) | Resolved: \(s.resolvedSetups)
        • Win Rate: \(String(format: "%.0f%%", s.winRate))
        • Wins: \(s.wins) | Losses: \(s.losses)
        • Avg R:R Achieved: \(String(format: "%.1f", s.avgRRAchieved))

        FLAT / Kill Decisions:
        • Total: \(s.totalFlats) | Evaluated: \(s.evaluatedFlats)
        • False FLATs: \(s.falseFlats) (\(String(format: "%.0f%%", s.falseFlatRate)))
        """
    }

    private func outcomeColor(_ result: String) -> Color {
        switch result {
        case "tp1_win", "tp2_win": return .green
        case "loss": return .red
        case "open": return .blue
        default: return .secondary
        }
    }
}
