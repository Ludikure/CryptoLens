import SwiftUI

class NavigationCoordinator: ObservableObject {
    @Published var selectedTab = 0  // 0=Chart, 1=Market, 2=AI, 3=Alerts
    @Published var pendingSymbol: String?
    @Published var showSettings = false

    func navigateToAnalysis(symbol: String) {
        pendingSymbol = symbol
        selectedTab = 0
    }
}
