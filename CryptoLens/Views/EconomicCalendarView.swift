import SwiftUI

struct EconomicCalendarView: View {
    let events: [EconomicEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Economic Calendar", systemImage: "calendar.badge.exclamationmark")
                .font(.subheadline).fontWeight(.semibold).foregroundStyle(.secondary)

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
                            }
                        }

                        Spacer()

                        // Date/time
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(event.date.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(event.date.formatted(date: .omitted, time: .shortened))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        // Warning if within 48h
                        if event.isWithin48Hours {
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

    private func impactColor(_ impact: String) -> Color {
        switch impact {
        case "High": return .red
        case "Medium": return .orange
        default: return .gray
        }
    }
}
