import SwiftUI

class NavigationCoordinator: ObservableObject {
    @Published var selectedTab = 0
    @Published var pendingSymbol: String?

    func navigateToAnalysis(symbol: String) {
        pendingSymbol = symbol
        selectedTab = 0
    }
}
