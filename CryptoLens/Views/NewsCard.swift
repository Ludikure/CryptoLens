import SwiftUI

/// Policy/macro headlines the analysis was given — shown whether or not the model cited them.
///
/// The split matters. The analysis names a headline ONLY when it plausibly explains the current
/// tape, and is explicitly forbidden from reaching for one otherwise, because catalyst proximity
/// was measured against 986 Fed releases 2020-2026 and does not predict the next 24h move
/// (docs/research/news-catalyst-test.md). That is the right rule for an analysis and a bad answer
/// to "what is going on in the world" — on a quiet day the model correctly says nothing, and the
/// whole feature looks broken. So: what the model was TOLD lives here; what it CONCLUDED lives in
/// the analysis. The header says "context" on its face so this is never read as a trade signal.
struct NewsCard: View {
    let feed: WorkerNewsService.Feed
    @State private var expanded = false

    /// Collapsed shows the top three: primaries sort first server-side, so the most authoritative
    /// items are the ones visible without a tap.
    private var visible: [WorkerNewsService.Headline] {
        expanded ? feed.headlines : Array(feed.headlines.prefix(3))
    }

    private func age(_ h: Int) -> String {
        h < 1 ? "now" : (h < 24 ? "\(h)h" : "\(h / 24)d")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "newspaper")
                    .font(Theme.micro)
                    .foregroundStyle(Theme.info)
                Text("CONTEXT")
                    .font(Theme.micro)
                    .foregroundStyle(.secondary)
                if feed.catalystActive {
                    // A primary-source release inside ~12h — the state that reframes a chase-FLAT
                    // as an entry-timing call rather than "the move is over".
                    Text("LIVE CATALYST")
                        .themedPill(Theme.caution)
                }
                Spacer()
                if feed.headlines.count > 3 {
                    Button(expanded ? "Less" : "All \(feed.headlines.count)") {
                        withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                    }
                    .font(Theme.micro)
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.info)
                }
            }

            ForEach(visible) { h in
                HStack(alignment: .top, spacing: 8) {
                    Circle()
                        .fill(h.isPrimary ? Theme.info : Color.secondary.opacity(0.45))
                        .frame(width: 5, height: 5)
                        .padding(.top, 6)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(h.title)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 4) {
                            Text(h.source)
                            if h.isPrimary { Text("· official") }
                            Text("· \(age(h.ageHours)) ago")
                        }
                        .font(Theme.micro)
                        .foregroundStyle(.secondary)
                    }
                }
            }

            Text("Background for the read — not a trade signal. Measured: policy timing doesn't predict the next move.")
                .font(Theme.micro)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
        }
        .themedCard(accent: feed.catalystActive ? Theme.caution : nil)
    }
}
