import SwiftUI

/// Small ⓘ button that shows a tooltip overlay on tap.
struct InfoTooltip: View {
    let title: String
    let explanation: String
    @State private var showTooltip = false

    var body: some View {
        Button { showTooltip = true } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showTooltip) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title)
                        .font(.headline)
                    Spacer()
                    Button { showTooltip = false } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(explanation)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer()
            }
            .padding(20)
            .background(Color(.tertiarySystemBackground))
            .presentationDetents([.height(180)])
            .presentationDragIndicator(.visible)
        }
    }
}
