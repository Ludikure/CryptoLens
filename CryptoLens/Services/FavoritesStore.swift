import Foundation

class FavoritesStore: ObservableObject {
    @Published var orderedFavorites: [String] {
        didSet { save() }
    }

    var favoriteSet: Set<String> { Set(orderedFavorites) }

    private let key = "favorite_coins"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let decoded = try? JSONDecoder().decode([String].self, from: data) {
            orderedFavorites = decoded
        } else {
            // Default favorites
            orderedFavorites = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        }
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

    private func save() {
        if let data = try? JSONEncoder().encode(orderedFavorites) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
