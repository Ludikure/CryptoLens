import SwiftUI

/// Makes transaction costs visible — the thing that measurably decides whether a strategy works.
///
/// **Why this card exists.** The single largest edge this project ever measured was the convex
/// 1R/5R structure at **+0.151R gross**. At a 0.25% round trip it becomes **−0.008R** — the entire
/// edge is consumed by fees (`docs/research/strategy-breakeven.md`, break-even = 0.238% round trip).
/// Fee drag is invisible in the moment and decisive over a year, which is exactly the shape of cost
/// that behaviour never corrects for on its own.
///
/// No commercial trading app shows you this, because churn is their revenue. For a personal tool it
/// is one of the highest-leverage things on the screen.
///
/// **What it deliberately does NOT claim.** It does not know which setups you actually took. It
/// reports what the setups the app surfaced WOULD have cost if traded at your configured size —
/// separating "surfaced" from "entry triggered", because only triggered setups would have incurred
/// a round trip.
struct FeeDragCard: View {
    let setups: [TrackedSetup]

    @AppStorage("accountSize") private var accountSize: Double = 28000
    @AppStorage("riskPercent") private var riskPercent: Double = 2.0
    @AppStorage("max_leverage") private var maxLeverage: Double = 3.5
    /// Round-trip cost as a percentage of notional. Default 0.171% = the user's measured Coinbase
    /// **Advanced 2** derivatives taker (0.070% × 2) plus the flat $0.12/contract NFA-clearing fee
    /// expressed against a nano-BTC notional (~0.031% round trip). Nano ETH is heavier (~0.098%)
    /// because the same $0.12 sits on a third of the notional.
    @AppStorage("feeRoundTripPercent") private var feeRoundTripPercent: Double = 0.171

    private static let lookbackDays = 30

    private struct Tally {
        var surfaced = 0
        var triggered = 0
        var feesIfTraded = 0.0
        var notional = 0.0
    }

    private var tally: Tally {
        let cutoff = Date().addingTimeInterval(-Double(Self.lookbackDays) * 86_400)
        var t = Tally()
        for s in setups where s.timestamp >= cutoff {
            t.surfaced += 1
            guard s.outcome.entryHit else { continue }
            guard let sizing = PositionSizer.compute(accountSize: accountSize,
                                                     riskPercent: riskPercent,
                                                     entry: s.setup.entry,
                                                     stop: s.setup.stopLoss,
                                                     symbol: s.symbol,
                                                     leverageCap: maxLeverage),
                  sizing.notional > 0 else { continue }
            t.triggered += 1
            t.notional += sizing.notional
            t.feesIfTraded += sizing.notional * (feeRoundTripPercent / 100.0)
        }
        return t
    }

    var body: some View {
        let t = tally
        if t.surfaced > 0 {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "minus.circle")
                        .font(Theme.micro)
                        .foregroundStyle(Theme.caution)
                    Text("COST OF TRADING")
                        .font(Theme.micro)
                        .foregroundStyle(Theme.caution)
                    Spacer()
                    Text("last \(Self.lookbackDays)d")
                        .font(Theme.micro)
                        .foregroundStyle(.secondary)
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(currency(t.feesIfTraded))
                        .font(.title2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(t.feesIfTraded > 0 ? Theme.caution : .primary)
                    Text("in fees if you'd taken every triggered setup")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 14) {
                    stat("\(t.surfaced)", "surfaced")
                    stat("\(t.triggered)", "triggered")
                    stat(String(format: "%.2f%%", annualisedDrag(t)), "of account / yr")
                }

                // The measured stake, stated without drama: this is the constraint that decided
                // the project's only real edge.
                Text(feeRoundTripPercent < 0.238
                     ? "Break-even for the validated convex edge is a 0.238% round trip. At ~\(String(format: "%.3f", feeRoundTripPercent))% you clear it."
                     : "Break-even for the validated convex edge is a 0.238% round trip. At ~\(String(format: "%.3f", feeRoundTripPercent))% you do not.")
                    .font(Theme.micro)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .themedCard(accent: Theme.caution)
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
            Text(label).font(Theme.micro).foregroundStyle(.secondary)
        }
    }

    /// Extrapolates the window's fee total to a full year, as a share of account equity.
    private func annualisedDrag(_ t: Tally) -> Double {
        guard accountSize > 0 else { return 0 }
        let perYear = t.feesIfTraded * (365.0 / Double(Self.lookbackDays))
        return perYear / accountSize * 100.0
    }

    private func currency(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = v < 100 ? 2 : 0
        return f.string(from: NSNumber(value: v)) ?? "$0"
    }
}
