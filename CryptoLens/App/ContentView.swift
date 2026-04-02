import SwiftUI

struct ContentView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"

    var body: some View {
        TabView(selection: $coordinator.selectedTab) {
            ChartTabView()
                .tabItem {
                    Label("Chart", systemImage: "chart.xyaxis.line")
                }
                .tag(0)
            MarketTabView()
                .tabItem {
                    Label("Market", systemImage: "building.columns")
                }
                .tag(1)
            AITabView()
                .tabItem {
                    Label("Analysis", systemImage: "brain")
                }
                .tag(2)
            AlertsView()
                .tabItem {
                    Label("Alerts", systemImage: alertsStore.activeAlerts.isEmpty ? "bell" : "bell.badge")
                }
                .tag(3)
        }
        .preferredColorScheme(colorSchemeOverride == "light" ? .light : colorSchemeOverride == "dark" ? .dark : nil)
        .sheet(isPresented: $coordinator.showSettings) {
            SettingsView()
        }
    }
}
