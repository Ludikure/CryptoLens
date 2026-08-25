import SwiftUI

/// Ranked opportunity book from the measured excursion model.
///
/// THE HONESTY REQUIREMENT DRIVES THE DESIGN. The research behind this (docs/research/
/// excursion-model.md) found ranking that survives regime and profitability that does not:
/// profitable in 1 of 5 rising-market periods, +0.109R gross with a MEDIAN OF ZERO. A card that
/// showed "EV +0.34R" in confident green would be presenting a regime bet as a model output — the
/// exact mistake the vault's regime-hold entry documents.
///
/// So the caveat is on the face, not behind a disclosure arrow; expected values are rendered in a
/// neutral colour rather than a bullish one; and the "mostly nothing" shape is stated in words.
struct OpportunityFeedCard: View {
    let book: WorkerOpportunitiesService.Book
    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            // Drawdown warnings lead, above any trade idea. This is the one signal that survived
            // every control in the research (drawdown −76.6% → −40.4%, replicated leave-one-symbol-
            // out), and it is defensive — so it outranks an opportunity list on the page.
            if let ws = book.crashWarnings, !ws.isEmpty {
                ForEach(ws) { w in crashRow(w) }
            }

            if book.opportunities.isEmpty {
                emptyState
            } else {
                ForEach(book.opportunities.prefix(5)) { op in
                    row(op)
                    if op.id != book.opportunities.prefix(5).last?.id { Divider().opacity(0.4) }
                }
                portfolioLine
            }

            caveat
        }
        .themedCard(accent: Theme.info)
    }

    // MARK: - Pieces

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("OPPORTUNITY BOOK").font(Theme.micro).foregroundStyle(.secondary)
            Spacer()
            if let m = book.model {
                // The model's own discrimination, shown rather than implied. ~0.60 is real and
                // a long way from certainty; hiding it would invite the number to be over-read.
                Text("AUC \(m.longAuc, specifier: "%.2f")/\(m.shortAuc, specifier: "%.2f")")
                    .font(Theme.micro).foregroundStyle(.tertiary)
            }
        }
    }

    private func crashRow(_ w: WorkerOpportunitiesService.CrashWarning) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: w.isHigh ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                    .font(.caption)
                Text("\(w.asset.replacingOccurrences(of: "USDT", with: "")) · DRAWDOWN RISK \(w.level)")
                    .font(Theme.micro.weight(.bold))
                Spacer()
                Text("\(w.probability * 100, specifier: "%.0f")%")
                    .font(.caption.monospacedDigit().weight(.semibold))
            }
            Text(w.message)
                .font(Theme.micro)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(w.isHigh ? Theme.danger : Theme.caution)
        .padding(8)
        .background((w.isHigh ? Theme.danger : Theme.caution).opacity(0.10),
                    in: RoundedRectangle(cornerRadius: 8))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No positions clear the bar").font(.subheadline.weight(.semibold))
            Text(book.skipped.isEmpty
                 ? "Nothing scored above zero expected value."
                 : "\(book.skipped.count) asset\(book.skipped.count == 1 ? "" : "s") screened, none tradeable.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }

    private func row(_ op: WorkerOpportunitiesService.Opportunity) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(op.asset.replacingOccurrences(of: "USDT", with: ""))
                    .font(.headline.weight(.semibold))
                Text(op.direction)
                    .font(Theme.micro)
                    .themedPill(op.direction == "LONG" ? Theme.bullish : Theme.bearish)
                if op.directionAgnostic {
                    // The validated convex structure pays either way; saying so beats implying
                    // a directional view the model does not hold.
                    Text("EITHER WAY").font(Theme.micro).themedPill(Theme.neutral)
                }
                Spacer()
                Text("$\(op.positionUsd, specifier: "%.0f")")
                    .font(.subheadline.monospacedDigit().weight(.medium))
            }

            HStack(spacing: 16) {
                stat("EV", String(format: "%+.2fR", op.expectedValueR))
                stat("hit", String(format: "%.0f%%", op.winProbability * 100))
                stat("payoff", String(format: "%.0f:1", op.payoffAsymmetry))
                stat("risk", String(format: "%.1f%%", op.riskFraction * 100))
            }

            Button { toggle(op.id) } label: {
                Text(expanded.contains(op.id) ? "Hide levels" : "Levels")
                    .font(Theme.micro).foregroundStyle(Theme.info)
            }
            .buttonStyle(.plain)

            if expanded.contains(op.id) {
                VStack(alignment: .leading, spacing: 3) {
                    levelRow("Entry", op.entry, Theme.info)
                    levelRow("Stop", op.stop, Theme.bearish)
                    levelRow("Target", op.target, Theme.bullish)
                    Text(String(format: "Stop is %.2f%% away · %.0f%% of trades reach neither barrier and exit at 72h",
                                op.stopDistancePercent, 20.0))
                        .font(Theme.micro).foregroundStyle(.tertiary)
                    if !op.bindingConstraints.isEmpty {
                        Text("Size limited by: \(op.bindingConstraints.joined(separator: ", "))")
                            .font(Theme.micro).foregroundStyle(Theme.caution)
                    }
                    if op.crashMultiplier < 1 {
                        Text(String(format: "Crash overlay cut size to %.0f%%", op.crashMultiplier * 100))
                            .font(Theme.micro).foregroundStyle(Theme.caution)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }

    private func levelRow(_ label: String, _ value: Double, _ color: Color) -> some View {
        HStack(spacing: 8) {
            Text(label).font(Theme.micro).foregroundStyle(.secondary).frame(width: 46, alignment: .leading)
            Text(fmt(value)).font(.caption.monospacedDigit()).foregroundStyle(color)
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(Theme.micro).foregroundStyle(.tertiary)
            // Deliberately NOT tinted by sign: a green +EV would read as a promise, and the
            // measured median outcome of this structure is exactly zero.
            Text(value).font(.caption.monospacedDigit().weight(.medium))
        }
    }

    private var portfolioLine: some View {
        HStack(spacing: 4) {
            Text(String(format: "%d positions · %.1f%% total risk", book.totals.positions,
                        book.totals.riskFraction * 100))
            Text("·")
            // The number that stops a correlated book looking diversified. T7 measured mean
            // pairwise crypto correlation at 0.62, so five positions are ~1.5 real bets.
            Text(String(format: "≈%.1f independent bets", book.totals.effectiveBets))
                .foregroundStyle(book.totals.effectiveBets < Double(book.totals.positions) * 0.5
                                 ? Theme.caution : .secondary)
        }
        .font(Theme.micro)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }

    private var caveat: some View {
        Text(book.caveat)
            .font(Theme.micro)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
    }

    // MARK: - Helpers

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    private func fmt(_ v: Double) -> String {
        if v >= 1000 { return String(format: "$%.0f", v) }
        if v >= 1 { return String(format: "$%.2f", v) }
        return String(format: "$%.5f", v)     // sub-dollar coins need the precision
    }
}
