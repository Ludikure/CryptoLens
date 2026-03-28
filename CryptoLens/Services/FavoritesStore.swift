import Foundation

class FavoritesStore: ObservableObject {
    @Published var orderedFavorites: [String] {
        didSet { save() }
    }

    @Published var customStocks: [AssetDefinition] {
        didSet { saveCustomStocks() }
    }

    var favoriteSet: Set<String> { Set(orderedFavorites) }

    private let key = "favorite_coins"
    private let customStocksKey = "custom_stocks"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let decoded = try? JSONDecoder().decode([String].self, from: data) {
            orderedFavorites = decoded
        } else {
            // Default favorites
            orderedFavorites = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        }

        if let data = UserDefaults.standard.data(forKey: customStocksKey),
           let decoded = try? JSONDecoder().decode([AssetDefinition].self, from: data) {
            customStocks = decoded
        } else {
            customStocks = []
        }
        Constants.customStocks = customStocks
    }

    func isFavorite(_ symbol: String) -> Bool {
        favoriteSet.contains(symbol)
    }

    func toggleFavorite(_ symbol: String) {
        if let idx = orderedFavorites.firstIndex(of: symbol) {
            orderedFavorites.remove(at: idx)
        } else {
            orderedFavorites.append(symbol)
        }
    }

    func removeFavorite(_ symbol: String) {
        orderedFavorites.removeAll { $0 == symbol }
    }

    func moveFavorites(from source: IndexSet, to destination: Int) {
        orderedFavorites.move(fromOffsets: source, toOffset: destination)
    }

    func addCustomStock(_ asset: AssetDefinition) {
        guard !customStocks.contains(where: { $0.id == asset.id }) else { return }
        customStocks.append(asset)
        Constants.customStocks = customStocks
    }

    private func save() {
        if let data = try? JSONEncoder().encode(orderedFavorites) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func saveCustomStocks() {
        if let data = try? JSONEncoder().encode(customStocks) {
            UserDefaults.standard.set(data, forKey: customStocksKey)
        }
    }
}
