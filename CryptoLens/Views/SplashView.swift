import SwiftUI

struct SplashView: View {
    @State private var isActive = false
    @State private var opacity = 1.0

    var body: some View {
        if isActive {
            EmptyView()
        } else {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()

                VStack(spacing: 16) {
                    Image("SplashLogo")
                        .resizable()
                        .frame(width: 100, height: 100)
                        .clipShape(RoundedRectangle(cornerRadius: 22))

                    Text("MarketScope")
                        .font(.title)
                        .fontWeight(.bold)

                    Text("Multi-Timeframe Analysis")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ProgressView()
                        .controlSize(.small)
                        .padding(.top, 8)
                }
            }
            .opacity(opacity)
            .task {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                withAnimation(.easeOut(duration: 0.3)) {
                    opacity = 0
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
                isActive = true
            }
        }
    }
}
