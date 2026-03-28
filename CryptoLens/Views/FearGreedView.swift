import SwiftUI

/// Prominent Fear & Greed meter displayed on the main analysis screen.
struct FearGreedView: View {
    let index: FearGreedIndex

    private var gaugeColor: Color {
        switch index.value {
        case 0..<25: return .red
        case 25..<45: return .orange
        case 45..<55: return .gray
        case 55..<75: return .green
        default: return Color(.systemGreen)
        }
    }

    private var emoji: String {
        switch index.value {
        case 0..<25: return "😱"
        case 25..<45: return "😟"
        case 45..<55: return "😐"
        case 55..<75: return "😊"
        default: return "🤑"
        }
    }

    var body: some View {
        HStack(spacing: 14) {
            // Gauge
            ZStack {
                Circle()
                    .stroke(Color(.systemGray5), lineWidth: 6)
                    .frame(width: 48, height: 48)
                Circle()
                    .trim(from: 0, to: CGFloat(index.value) / 100.0)
                    .stroke(gaugeColor, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .frame(width: 48, height: 48)
                    .rotationEffect(.degrees(-90))
                Text("\(index.value)")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .monospacedDigit()
            }

            // Label
            VStack(alignment: .leading, spacing: 2) {
                Text("Fear & Greed")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    Text(emoji)
                        .font(.subheadline)
                    Text(index.classification)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(gaugeColor)
                }
            }

            Spacer()

            // Mini bar
            VStack(alignment: .trailing, spacing: 2) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color(.systemGray5))
                            .frame(height: 6)
                        Capsule()
                            .fill(gaugeColor)
                            .frame(width: geo.size.width * CGFloat(index.value) / 100.0, height: 6)
                    }
                }
                .frame(width: 80, height: 6)
                HStack(spacing: 0) {
                    Text("Fear")
                        .font(.system(size: 8))
                        .foregroundStyle(.red.opacity(0.6))
                    Spacer()
                    Text("Greed")
                        .font(.system(size: 8))
                        .foregroundStyle(.green.opacity(0.6))
                }
                .frame(width: 80)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
