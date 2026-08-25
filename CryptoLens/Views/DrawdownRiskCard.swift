import SwiftUI

/// Drawdown-risk warnings — what survived of the opportunity book.
///
/// The book itself proposed trades, and on 2026-08-25 it was seen recommending an ADA SHORT on the
/// same screen where the AI analysis showed an ADA LONG SETUP whose own text said "this is a chase,
/// wait for a pullback". Three contradictory instructions, one symbol, one screen.
///
/// The cause was architectural rather than cosmetic: two independent recommendation systems were
/// rendering side by side with nothing reconciling them, and NEITHER is verified — the Conviction
/// Envelope failed end-to-end verification that morning (it beats a coverage-matched random gate by
/// +0.0012R), and the excursion model ranks but is regime-dependent. Two unverified opinions that
/// disagree are strictly worse than one.
///
/// So the trade cards are gone and the AI analysis is the single place a trade is proposed. What
/// remains here is the one component with replicated out-of-sample evidence behind it: the crash
/// model, which cut BTC drawdown from −76.6% to −40.4% and replicated leave-one-symbol-out with
/// placebos collapsing to noise. It says nothing about direction, so it cannot contradict anything.
struct DrawdownRiskCard: View {
    let warnings: [WorkerOpportunitiesService.CrashWarning]

    var body: some View {
        if warnings.isEmpty {
            EmptyView()
        } else {
            let high = warnings.filter(\.isHigh)
            let names = warnings.map { $0.asset.replacingOccurrences(of: "USDT", with: "") }
            let colour = high.isEmpty ? Theme.caution : Theme.danger

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: high.isEmpty ? "exclamationmark.circle" : "exclamationmark.triangle.fill")
                        .font(.caption)
                    Text(names.count == 1
                         ? "\(names[0]) looks shakier than usual"
                         : "\(names.prefix(3).joined(separator: ", ")) look shakier than usual")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                }
                Text(warnings.first?.message ?? "")
                    .font(Theme.micro)
                    .fixedSize(horizontal: false, vertical: true)

                // Says what it is NOT, because a risk gauge next to a trade card invites being read
                // as one. This never picks a side.
                Text("This is a risk gauge, not a trade idea — it says nothing about direction.")
                    .font(Theme.micro).foregroundStyle(.secondary)
            }
            .foregroundStyle(colour)
            .themedCard(accent: colour)
        }
    }
}
