import SwiftUI

struct ContentView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"

    var body: some View {
        TabView(selection: $coordinator.selectedTab) {
            AnalysisView()
                .tabItem {
                    Label("Analysis", systemImage: "chart.line.uptrend.xyaxis")
                }
                .tag(0)
            AlertsView()
                .tabItem {
                    Label("Alerts", systemImage: alertsStore.activeAlerts.isEmpty ? "bell" : "bell.badge")
                }
                .tag(1)
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
                .tag(2)
        }
        .preferredColorScheme(colorSchemeOverride == "light" ? .light : colorSchemeOverride == "dark" ? .dark : nil)
    }
}
