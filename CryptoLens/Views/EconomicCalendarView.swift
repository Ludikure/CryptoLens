import SwiftUI

struct EconomicCalendarView: View {
    let events: [EconomicEvent]

    private var nextHighImpactEvent: EconomicEvent? {
        events.first { $0.isUpcoming && $0.isHighImpact }
    }

    private func countdownText(for event: EconomicEvent, now: Date) -> String {
        let seconds = event.date.timeIntervalSince(now)
        if seconds < 0 { return "NOW" }
        if seconds < 5 * 60 { return "IMMINENT" }
        let hours = Int(seconds) / 3600
        let minutes = (Int(seconds) % 3600) / 60
        if hours >= 1 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Economic Calendar", systemImage: "calendar.badge.exclamationmark")
                .font(.subheadline).fontWeight(.semibold).foregroundStyle(.secondary)

            if let nextEvent = nextHighImpactEvent {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let text = countdownText(for: nextEvent, now: context.date)
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                        Text("\(nextEvent.title) in \(text)")
                            .font(.caption)
                            .fontWeight(.semibold)
                    }
                    .foregroundStyle(.orange)
                    .padding(.vertical, 2)
                }
            }

            if events.isEmpty {
                Text("No high-impact events this week")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(events.prefix(5)) { event in
                    HStack(spacing: 8) {
                        // Impact dot
                        Circle()
                            .fill(impactColor(event.impact))
                            .frame(width: 6, height: 6)

                        // Title + country
                        VStack(alignment: .leading, spacing: 1) {
                            Text(event.title)
                                .font(.caption)
                                .fontWeight(.medium)
                                .lineLimit(1)
                            HStack(spacing: 4) {
                                Text(event.country)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                if let forecast = event.forecast, !forecast.isEmpty {
                                    Text("Exp: \(forecast)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                                if let prev = event.previous, !prev.isEmpty {
                                    Text("Prev: \(prev)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                                if event.hasActual {
                                    Text("Act: \(event.actual!)")
                                        .font(.caption2).fontWeight(.semibold)
                                        .foregroundStyle(event.surprise == "BEAT" ? .green : event.surprise == "MISS" ? .red : .primary)
                                }
                            }
                        }

                        Spacer()

                        // Date/time (ET)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(event.date.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(Self.etTimeFormatter.string(from: event.date))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        if !event.hasActual && event.isUpcoming {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                    if event.id != events.prefix(5).last?.id {
                        Divider()
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private static let etTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a 'ET'"
        f.timeZone = TimeZone(identifier: "America/New_York")
        return f
    }()

    private func impactColor(_ impact: String) -> Color {
        switch impact {
        case "High": return .red
        case "Medium": return .orange
        default: return .gray
        }
    }
}
