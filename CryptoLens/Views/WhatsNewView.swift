import SwiftUI

struct WhatsNewView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    VStack(spacing: 8) {
                        Image("SplashLogo")
                            .resizable()
                            .frame(width: 80, height: 80)
                            .clipShape(RoundedRectangle(cornerRadius: 18))

                        Text("What's New")
                            .font(.largeTitle)
                            .fontWeight(.bold)

                        Text("Version \(WhatsNewManager.currentVersion) (\(WhatsNewManager.currentBuild))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 20)

                    // Features
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(WhatsNewManager.currentFeatures) { feature in
                            featureRow(feature)
                        }
                    }
                    .padding(.horizontal, 20)

                    Spacer(minLength: 40)

                    Button {
                        dismiss()
                    } label: {
                        Text("Continue")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 30)
                }
            }
            .interactiveDismissDisabled()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.title3)
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
    }

    private func featureRow(_ feature: WhatsNewFeature) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: feature.icon)
                .font(.title2)
                .foregroundStyle(feature.color)
                .frame(width: 40, height: 40)
                .background(feature.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 4) {
                Text(feature.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Text(feature.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Data Model

struct WhatsNewFeature: Identifiable {
    let id = UUID()
    let icon: String
    let title: String
    let description: String
    let color: Color
}

// MARK: - Manager

enum WhatsNewManager {
    private static let lastSeenBuildKey = "whats_new_last_seen_build"

    static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    static var currentBuild: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }

    /// Returns true if the user hasn't seen the What's New for this build.
    static var shouldShow: Bool {
        let lastSeen = UserDefaults.standard.string(forKey: lastSeenBuildKey) ?? ""
        return lastSeen != currentBuild && !currentFeatures.isEmpty
    }

    /// Mark the current build's What's New as seen.
    static func markSeen() {
        UserDefaults.standard.set(currentBuild, forKey: lastSeenBuildKey)
    }

    // MARK: - Features per build
    // Add new entries at the top. Remove old ones after a few releases.

    static var currentFeatures: [WhatsNewFeature] {
        features[currentBuild] ?? []
    }

    private static let features: [String: [WhatsNewFeature]] = [
        "17": [
            WhatsNewFeature(
                icon: "rectangle.split.3x1",
                title: "New Tab Navigation",
                description: "Chart, Market, and AI now have dedicated tabs for a cleaner, faster experience.",
                color: .blue
            ),
            WhatsNewFeature(
                icon: "bell.badge",
                title: "Push Notifications",
                description: "Price alerts now deliver push notifications even when the app is closed.",
                color: .orange
            ),
            WhatsNewFeature(
                icon: "clock.arrow.circlepath",
                title: "Analysis History",
                description: "Every AI analysis is saved. Review past calls, compare price changes, and track setup outcomes.",
                color: .purple
            ),
            WhatsNewFeature(
                icon: "chart.xyaxis.line",
                title: "Chart Zoom & Pan",
                description: "Pinch to zoom and drag to scroll through candle history.",
                color: .green
            ),
            WhatsNewFeature(
                icon: "hand.tap",
                title: "Haptic Feedback",
                description: "Feel alerts trigger and analyses complete with haptic vibrations.",
                color: .cyan
            ),
        ],
    ]
}
