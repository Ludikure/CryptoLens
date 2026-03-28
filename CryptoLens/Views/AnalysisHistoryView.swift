import SwiftUI

struct AnalysisHistoryView: View {
    let symbol: String
    @State private var history: [AnalysisResult] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if history.isEmpty {
                    ContentUnavailableView(
                        "No History",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Past analyses for \(symbol) will appear here.")
                    )
                } else {
                    List {
                        ForEach(history) { result in
                            DisclosureGroup {
                                if !result.claudeAnalysis.isEmpty {
                                    Text(result.claudeAnalysis)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .padding(.top, 4)
                                } else {
                                    Text("No AI analysis for this snapshot.")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            } label: {
                                historyRow(result)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("History: \(symbol)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                history = AnalysisHistoryStore.load(symbol: symbol)
            }
        }
    }

    private func historyRow(_ result: AnalysisResult) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(result.timestamp.formatted(date: .abbreviated, time: .shortened))
                .font(.subheadline)
                .fontWeight(.medium)

            HStack(spacing: 8) {
                Text(Formatters.formatPrice(result.daily.price))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(biasSummary(result))
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(biasColor(result))
            }
        }
        .padding(.vertical, 2)
    }

    private func biasSummary(_ result: AnalysisResult) -> String {
        let biases = [result.tf1.bias, result.tf2.bias, result.tf3.bias]
        let bearish = biases.filter { $0.contains("Bearish") }.count
        let bullish = biases.filter { $0.contains("Bullish") }.count
        if bullish > bearish {
            return "\(bullish)/3 Bullish"
        } else if bearish > bullish {
            return "\(bearish)/3 Bearish"
        } else {
            return "Mixed"
        }
    }

    private func biasColor(_ result: AnalysisResult) -> Color {
        let biases = [result.tf1.bias, result.tf2.bias, result.tf3.bias]
        let bearish = biases.filter { $0.contains("Bearish") }.count
        let bullish = biases.filter { $0.contains("Bullish") }.count
        if bullish > bearish { return .green }
        if bearish > bullish { return .red }
        return .secondary
    }
}
