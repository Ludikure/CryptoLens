import SwiftUI

/// Ranked opportunity book, written to be read in five seconds.
///
/// THE FIRST VERSION FAILED THAT TEST. It rendered six near-identical drawdown warnings (41/41/43/
/// 41/50/39% against a 41% base rate — i.e. five of them meant "today is normal"), then a row of
/// `EV +0.01R · hit 10% · payoff 5:1 · risk 0.7%`, then "≈1.0 independent bets", then a paragraph of
/// research prose. The user's verdict was "I don't know what any of this means", and they were right.
///
/// Rewritten on three rules:
///   1. MONEY, NOT R. "Risk $196 to make $980" is the same fact as "EV +0.01R, payoff 5:1" and one
///      of them can be acted on.
///   2. A WARNING MUST BE UNUSUAL. Thresholds moved to a margin over the base rate (see crash.ts), so
///      an ordinary day now produces silence instead of a wall of orange.
///   3. SAY THE UNCOMFORTABLE PART IN ONE LINE. The honesty requirement is unchanged — this structure
///      loses far more often than it wins — but a paragraph of hedging is not honesty, it is noise.
struct OpportunityFeedCard: View {
    let book: WorkerOpportunitiesService.Book
    @State private var showDetail: Set<String> = []

    private var warnings: [WorkerOpportunitiesService.CrashWarning] { book.crashWarnings ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("WHAT TO DO").font(Theme.micro).foregroundStyle(.secondary)
                Spacer()
            }

            if !warnings.isEmpty { riskLine }

            if book.opportunities.isEmpty {
                nothingToDo
            } else {
                ForEach(book.opportunities.prefix(3)) { op in
                    tradeRow(op)
                    if op.id != book.opportunities.prefix(3).last?.id { Divider().opacity(0.3) }
                }
                Text(oneLineCaveat)
                    .font(Theme.micro).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .themedCard(accent: warnings.contains(where: \.isHigh) ? Theme.danger : Theme.info)
    }

    // MARK: - Risk

    /// One line, however many symbols are flagged. Six separate boxes saying the same sentence is
    /// how a warning becomes wallpaper.
    private var riskLine: some View {
        let high = warnings.filter(\.isHigh)
        let names = warnings.map { $0.asset.replacingOccurrences(of: "USDT", with: "") }
        let colour = high.isEmpty ? Theme.caution : Theme.danger
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: high.isEmpty ? "exclamationmark.circle" : "exclamationmark.triangle.fill")
                    .font(.caption)
                Text(names.count == 1
                     ? "\(names[0]) looks shakier than usual"
                     : "\(names.prefix(3).joined(separator: ", ")) look shakier than usual")
                    .font(.subheadline.weight(.semibold))
            }
            Text(warnings.first?.message ?? "")
                .font(Theme.micro)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(colour)
        .padding(10)
        .background(colour.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    private var nothingToDo: some View {
        // "The analysis blocked this" and "the maths did not clear" are different answers and the
        // user is entitled to know which. Conflating them is what made the book look like it was
        // contradicting the AI on the same screen.
        let blocked = book.skipped.filter { $0.reasons.contains { $0.hasPrefix("analysis says stand aside") } }
        let noisy = book.skipped.filter { $0.reasons.contains { $0.contains("noise band") } }

        return VStack(alignment: .leading, spacing: 4) {
            Text("Nothing worth trading right now").font(.subheadline.weight(.semibold))
            Text(explanation(blocked: blocked.count, noisy: noisy.count, total: book.skipped.count))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func explanation(blocked: Int, noisy: Int, total: Int) -> String {
        if total == 0 { return "No setup cleared the bar." }
        var parts: [String] = []
        if blocked > 0 {
            parts.append("\(blocked) blocked by the same checks the AI analysis uses — "
                         + "things like chasing a move that has already run.")
        }
        if noisy > 0 {
            parts.append("\(noisy) rejected because the stop sits inside normal price noise: "
                         + "random movement would knock you out before the trade had a chance.")
        }
        if parts.isEmpty { parts.append("None cleared the bar.") }
        return "Checked \(total) coin\(total == 1 ? "" : "s"). " + parts.joined(separator: " ")
    }

    // MARK: - A trade, in money

    private func tradeRow(_ op: WorkerOpportunitiesService.Opportunity) -> some View {
        let atRisk = book.equity * op.riskFraction
        let toWin = atRisk * op.payoffAsymmetry
        let oneIn = op.winProbability > 0 ? Int((1 / op.winProbability).rounded()) : 0
        let name = op.asset.replacingOccurrences(of: "USDT", with: "")
        let thin = op.expectedValueR < 0.05

        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(name).font(.headline.weight(.semibold))
                Text(op.direction == "LONG" ? "bet it rises" : "bet it falls")
                    .font(Theme.micro)
                    .themedPill(op.direction == "LONG" ? Theme.bullish : Theme.bearish)
                Spacer()
            }

            // The whole trade in one sentence, in dollars.
            HStack(spacing: 4) {
                Text("Risk").font(.subheadline).foregroundStyle(.secondary)
                Text("$\(Int(atRisk))").font(.subheadline.weight(.bold).monospacedDigit())
                Text("to make").font(.subheadline).foregroundStyle(.secondary)
                Text("$\(Int(toWin))").font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(Theme.bullish)
            }

            // The part people get wrong about convex bets: it loses most of the time BY DESIGN.
            if oneIn > 0 {
                Text("Wins about 1 time in \(oneIn) — you should expect a run of losses, and the "
                     + "occasional win is what pays for them.")
                    .font(Theme.micro).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if thin {
                Text("The edge here is tiny — close to a coin flip after costs.")
                    .font(Theme.micro).foregroundStyle(Theme.caution)
            }
            if op.crashMultiplier < 1 {
                Text("Size already cut to \(Int(op.crashMultiplier * 100))% because drawdown risk is up.")
                    .font(Theme.micro).foregroundStyle(Theme.caution)
            }

            Button { toggle(op.id) } label: {
                Text(showDetail.contains(op.id) ? "Hide prices" : "Show prices")
                    .font(Theme.micro).foregroundStyle(Theme.info)
            }
            .buttonStyle(.plain)

            if showDetail.contains(op.id) {
                VStack(alignment: .leading, spacing: 3) {
                    priceRow("Get in at", op.entry, Theme.info)
                    priceRow("Get out if it hits", op.stop, Theme.bearish)
                    priceRow("Take profit at", op.target, Theme.bullish)
                    Text("Position size $\(Int(op.positionUsd)). Give it up to 3 days.")
                        .font(Theme.micro).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func priceRow(_ label: String, _ v: Double, _ c: Color) -> some View {
        HStack(spacing: 8) {
            Text(label).font(Theme.micro).foregroundStyle(.secondary)
                .frame(width: 118, alignment: .leading)
            Text(fmt(v)).font(.caption.monospacedDigit()).foregroundStyle(c)
        }
    }

    /// One sentence. The full research caveat lives in the vault, not on a phone screen.
    private var oneLineCaveat: String {
        "These are ranked by the model, not guaranteed. It picks better than chance, but it made "
        + "money in only 1 of 5 rising markets tested — it works best when things are falling."
    }

    private func toggle(_ id: String) {
        if showDetail.contains(id) { showDetail.remove(id) } else { showDetail.insert(id) }
    }

    private func fmt(_ v: Double) -> String {
        if v >= 1000 {
            // Swift's String(format:) has no thousands flag; group manually.
            let n = NSNumber(value: v)
            let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = 0
            return "$" + (f.string(from: n) ?? String(format: "%.0f", v))
        }
        if v >= 1 { return String(format: "$%.2f", v) }
        return String(format: "$%.5f", v)
    }
}
