import SwiftUI

@main
struct CryptoLensApp: App {
    @StateObject private var analysisService = AnalysisService()
    @StateObject private var favoritesStore = FavoritesStore()
    @StateObject private var alertsStore = AlertsStore()

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
        }
    }
}
