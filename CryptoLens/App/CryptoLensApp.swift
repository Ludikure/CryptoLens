import SwiftUI

@main
struct MarketScopeApp: App {
    @StateObject private var analysisService = AnalysisService()
    @StateObject private var favoritesStore = FavoritesStore()
    @StateObject private var alertsStore = AlertsStore()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        BackgroundRefreshManager.register()
        AlertsStore.requestPermission()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(analysisService)
                .environmentObject(favoritesStore)
                .environmentObject(alertsStore)
                .onAppear { analysisService.alertsStore = alertsStore }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                    BackgroundRefreshManager.schedule()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        if let symbol = analysisService.currentSymbol {
                            analysisService.startAutoRefresh(symbol: symbol)
                        }
                    case .background:
                        analysisService.stopAutoRefresh()
                    default:
                        break
                    }
                }
        }
    }
}
