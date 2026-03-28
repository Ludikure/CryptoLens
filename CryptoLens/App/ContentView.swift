import SwiftUI

struct ContentView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"

    var body: some View {
        TabView {
            AnalysisView()
                .tabItem {
                    Label("Analysis", systemImage: "chart.line.uptrend.xyaxis")
                }
            AlertsView()
                .tabItem {
                    Label("Alerts", systemImage: alertsStore.activeAlerts.isEmpty ? "bell" : "bell.badge")
                }
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .preferredColorScheme(colorSchemeOverride == "light" ? .light : colorSchemeOverride == "dark" ? .dark : nil)
    }
}
