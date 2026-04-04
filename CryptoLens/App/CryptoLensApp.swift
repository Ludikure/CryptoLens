import SwiftUI
import UIKit
import UserNotifications

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        print("[MarketScope] AppDelegate didFinishLaunching — registering for remote notifications")
        #endif
        UNUserNotificationCenter.current().delegate = self
        application.registerForRemoteNotifications()
        return true
    }

    // Show push banners even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        print("[MarketScope] APNs push token: \(token.prefix(20))...")
        #endif
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
    @State private var showWhatsNew = false

    init() {
        BackgroundRefreshManager.register()
        AlertsStore.requestPermission()
        PushService.ensureRegistered()
        #if DEBUG
        print("[MarketScope] Device ID: \(PushService.deviceId)")
        print("[MarketScope] Auth Token: \(PushService.authToken ?? "nil")")
        #endif
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
                    analysisService.configure(alertsStore: alertsStore)
                    analysisService.prefetchFavorites(favoritesStore.orderedFavorites)
                    alertsStore.syncFromServer()
                    // Show What's New after splash dismisses
                    if WhatsNewManager.shouldShow {
                        Task {
                            try? await Task.sleep(nanoseconds: 1_800_000_000)
                            showWhatsNew = true
                        }
                    }
                }
                .sheet(isPresented: $showWhatsNew, onDismiss: {
                    WhatsNewManager.markSeen()
                }) {
                    WhatsNewView()
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
                        alertsStore.processPendingBackgroundAlerts()
                        alertsStore.syncFromServer()
                        // Replay any offline alert changes
                        if ConnectionStatus.shared.pendingOfflineChanges {
                            PushService.syncAlerts(alertsStore.alerts)
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
