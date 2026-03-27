import SwiftUI

struct ContentView: View {
    @EnvironmentObject var alertsStore: AlertsStore

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
            PositionCalculatorView()
                .tabItem {
                    Label("Calculator", systemImage: "plusminus")
                }
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}
