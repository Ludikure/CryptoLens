import SwiftUI

@MainActor
class NavigationCoordinator: ObservableObject {

    /// Tab identities, named rather than left as the bare ints they were.
    ///
    /// The raw values are the ones already in use, deliberately: `symbol` KEEPS 0 so
    /// `navigateToAnalysis` — which a tapped push notification lands in — still reaches the symbol
    /// screen rather than the scanner. `opportunities` takes a fresh value instead of claiming 0,
    /// because a renumbering would silently redirect that path to the wrong screen.
    enum Tab: Int {
        case opportunities = 6
        case symbol = 0
        case market = 1
        case chart = 4
        case record = 5
    }

    /// The app opens on the scanner (corrected spec §42, Phase 1): "is there anything worth doing
    /// right now?" is the question that precedes a decision. "What about this symbol?" is one you
    /// can only ask after you have already made it.
    @Published var selectedTab: Int = {
        #if DEBUG
        // `-startTab record` as a launch argument opens on that tab. Screenshot tooling only —
        // simctl cannot tap a tab bar, and a screen that cannot be screenshotted does not get
        // looked at (the fee-on-row regression of 2026-08-28 was caught only by looking).
        if let name = UserDefaults.standard.string(forKey: "startTab") {
            switch name {
            case "record": return Tab.record.rawValue
            case "symbol": return Tab.symbol.rawValue
            case "market": return Tab.market.rawValue
            case "chart":  return Tab.chart.rawValue
            default: break
            }
        }
        #endif
        return Tab.opportunities.rawValue
    }()
    @Published var pendingSymbol: String?
    @Published var showSettings = false

    func navigateToAnalysis(symbol: String) {
        pendingSymbol = symbol
        selectedTab = Tab.symbol.rawValue
    }

    /// Follow a scanner row into its symbol.
    func openSymbol(_ symbol: String) {
        pendingSymbol = symbol
        selectedTab = Tab.symbol.rawValue
    }
}
