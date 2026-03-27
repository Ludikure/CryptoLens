import SwiftUI

/// Shows live "ago" timers for data and analysis freshness.
struct TimestampBar: View {
    let dataTimestamp: Date
    let analysisTimestamp: Date?

    @State private var now = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 16) {
            // Data freshness
            HStack(spacing: 4) {
                Image(systemName: "chart.bar")
                    .font(.caption2)
                Text("Data: \(agoText(from: dataTimestamp))")
                    .font(.caption2)
            }
            .foregroundStyle(freshnessColor(dataTimestamp, staleAfter: 120))

            // Analysis freshness
            HStack(spacing: 4) {
                Image(systemName: "brain")
                    .font(.caption2)
                if let at = analysisTimestamp {
                    Text("Analysis: \(agoText(from: at))")
                        .font(.caption2)
                } else {
                    Text("Analysis: —")
                        .font(.caption2)
                }
            }
            .foregroundStyle(analysisTimestamp != nil ? freshnessColor(analysisTimestamp!, staleAfter: 600) : Color.gray.opacity(0.5))

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .onReceive(timer) { now = $0 }
    }

    private func agoText(from date: Date) -> String {
        let seconds = Int(now.timeIntervalSince(date))
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        return "\(hours)h \(minutes % 60)m ago"
    }

    private func freshnessColor(_ date: Date, staleAfter: TimeInterval) -> Color {
        let age = now.timeIntervalSince(date)
        if age < staleAfter * 0.5 { return .secondary }
        if age < staleAfter { return .orange }
        return .red
    }
}
