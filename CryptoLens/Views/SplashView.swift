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
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    withAnimation(.easeOut(duration: 0.3)) {
                        opacity = 0
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        isActive = true
                    }
                }
            }
        }
    }
}
