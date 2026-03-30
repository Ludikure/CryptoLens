import SwiftUI
import UIKit

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushService.registerDevice(token: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        print("[MarketScope] Push registration failed: \(error)")
        #endif
    }
}

@main
struct MarketScopeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var analysisService = AnalysisService()
    @StateObject private var favoritesStore = FavoritesStore()
    @StateObject private var alertsStore = AlertsStore()
    @StateObject private var navigationCoordinator = NavigationCoordinator()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        BackgroundRefreshManager.register()
        AlertsStore.requestPermission()
        UIApplication.shared.registerForRemoteNotifications()
        PushService.ensureRegistered()
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                    .environmentObject(analysisService)
                    .environmentObject(favoritesStore)
                    .environmentObject(alertsStore)
                    .environmentObject(navigationCoordinator)

                SplashView()
            }
                .onAppear {
                    analysisService.alertsStore = alertsStore
                    analysisService.prefetchFavorites(favoritesStore.orderedFavorites)
                    alertsStore.syncFromServer()
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                    BackgroundRefreshManager.schedule()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        if let symbol = analysisService.currentSymbol {
                            analysisService.startAutoRefresh(symbol: symbol)
                        }
                        alertsStore.syncFromServer()
                    case .background:
                        analysisService.stopAutoRefresh()
                    default:
                        break
                    }
                }
        }
    }
}
