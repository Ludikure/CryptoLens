import SwiftUI
import SwiftData
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

    // Tapping a notification (incl. the "analysis ready" push) foregrounds the app; the
    // scenePhase .active handler runs recoverPendingAnalyses(), but trigger it here too so a tap
    // that doesn't change scenePhase (already-active) still resumes the finished job.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            AnalysisService.shared?.recoverPendingAnalyses()
            completionHandler()
        }
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
        // Register risk-plan defaults so a FRESH install actually SENDS them to the server prompt.
        // @AppStorage shows 25000/2.0 in the UI without persisting, so WorkerFullAnalysisService
        // (which reads UserDefaults.double, 0 if unset) sent NO sizing until the user opened
        // Settings — the card showed "$500 of $25,000" while the LLM got nothing. (2026-07-02)
        UserDefaults.standard.register(defaults: ["accountSize": 25000.0, "riskPercent": 2.0, "max_leverage": 3.0])
        // Analysis runs entirely on the shared-brain Worker (Phase 4 complete) — no on-device
        // engine, no toggle. The Worker is the single source of truth for the prompt + LLM.
        BackgroundRefreshManager.register()
        AlertsStore.requestPermission()
        PushService.ensureRegistered()
        // Migrate kill duration / regime state from UserDefaults → SwiftData
        AnalysisStateMigration.migrateIfNeeded()
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
                .modelContainer(for: [AnalysisState.self])
                .onAppear {
                    analysisService.configure(alertsStore: alertsStore)
                    analysisService.prefetchFavorites(favoritesStore.orderedFavorites)
                    PushService.syncWatchlist(favoritesStore.orderedFavorites)
                    alertsStore.syncFromServer()
                    Task { await OutcomeTracker.restoreFromServer() }
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
                        // Fire-and-forget recovery: resume ANY outstanding analysis job (the box
                        // finished it while we were away → cached result, no second LLM spend).
                        // Scanning all pending symbols (not just currentSymbol) covers the
                        // cold-launch case (currentSymbol not yet set when a tapped "ready" push
                        // reactivates the app) and the switched-symbol case. recoverPendingAnalyses
                        // switches to the recovered symbol so the result is actually shown.
                        analysisService.recoverPendingAnalyses()
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
