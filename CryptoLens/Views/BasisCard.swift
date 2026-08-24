import SwiftUI

/// Cash-and-carry monitor: the one mechanism that survived the 2026-08-23 research arc.
///
/// Shown because it needs NO directional forecast — the future converges to spot at expiry by
/// contract, so the gap closes whatever price does. Hidden when nothing is paying, because a
/// permanently-visible card advertising a trade that isn't currently worth taking is how a monitor
/// becomes wallpaper.
struct BasisCard: View {
    let snapshot: WorkerBasisService.Snapshot
    @State private var expanded = false

    private var best: WorkerBasisService.Contract? { snapshot.best }

    var body: some View {
        if let best, let net = best.netAnnualized {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.left.arrow.right")
                        .font(Theme.micro)
                        .foregroundStyle(Theme.info)
                    Text("CARRY")
                        .font(Theme.micro)
                        .foregroundStyle(Theme.info)
                    Spacer()
                    Text("no forecast needed")
                        .font(Theme.micro)
                        .foregroundStyle(.secondary)
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(String(format: "%.1f%%", net * 100))
                        .font(.title2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.bullish)
                    Text("net annualized")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text("\(best.underlying) \(shortName(best.productId)) · \(String(format: "%.2f%%", best.basis * 100)) over \(Int(best.daysToExpiry.rounded()))d")
                    .font(.caption)
                    .foregroundStyle(.primary)

                // The caveat is on the face of the card, not buried. Buying the spot leg to run
                // this is break-even at best: Coinbase retail spot fees run 0.40-0.60% PER SIDE
                // against a ~1% basis. Only the covered form clears.
                Text("Sell futures against BTC you already hold. Buying spot to run it is break-even — spot fees eat the basis.")
                    .font(Theme.micro)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if expanded {
                    Divider().padding(.vertical, 2)
                    ForEach(snapshot.contracts) { c in
                        HStack {
                            Text("\(c.underlying) \(shortName(c.productId))")
                                .font(Theme.micro)
                            Spacer()
                            Text("\(Int(c.daysToExpiry.rounded()))d")
                                .font(Theme.micro).foregroundStyle(.secondary)
                            Text(String(format: "%.1f%%", (c.netAnnualized ?? 0) * 100))
                                .font(Theme.micro.monospacedDigit())
                                .foregroundStyle((c.netAnnualized ?? 0) > 0 ? Theme.bullish : Theme.bearish)
                                .frame(width: 52, alignment: .trailing)
                        }
                    }
                    if !snapshot.marginNote.isEmpty {
                        Text(snapshot.marginNote)
                            .font(Theme.micro)
                            .foregroundStyle(Theme.caution)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }

                Button(expanded ? "Hide contracts" : "All contracts") {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                }
                .font(Theme.micro)
                .buttonStyle(.plain)
                .foregroundStyle(Theme.info)
            }
            .themedCard(accent: Theme.info)
        }
    }

    /// "BIT-25SEP26-CDE" -> "25SEP26"
    private func shortName(_ pid: String) -> String {
        let parts = pid.split(separator: "-")
        return parts.count >= 2 ? String(parts[1]) : pid
    }
}
