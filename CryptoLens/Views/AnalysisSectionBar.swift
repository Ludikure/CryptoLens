import SwiftUI

struct AnalysisSectionBar: View {
    @Binding var activeSection: String
    let onTap: (String) -> Void

    private let sections: [(id: String, label: String, icon: String)] = [
        ("overview", "Overview", "chart.xyaxis.line"),
        ("market", "Market", "globe"),
        ("ai", "AI Analysis", "text.quote"),
        ("indicators", "Indicators", "tablecells"),
    ]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(sections, id: \.id) { section in
                        let isActive = activeSection == section.id
                        Button {
                            onTap(section.id)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: section.icon)
                                    .font(.system(size: 9))
                                Text(section.label)
                                    .font(.caption2)
                                    .fontWeight(isActive ? .bold : .medium)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .foregroundStyle(isActive ? .white : .secondary)
                            .background(isActive ? Color.accentColor : Color(.systemGray5), in: Capsule())
                        }
                        .buttonStyle(.borderless)
                        .id(section.id)
                    }
                }
                .padding(.horizontal, 4)
            }
            .onChange(of: activeSection) {
                withAnimation { proxy.scrollTo(activeSection, anchor: .center) }
            }
        }
    }
}
