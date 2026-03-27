import Foundation
import SwiftUI

struct CoinDefinition: Identifiable, Equatable {
    let id: String          // Binance symbol: "BTCUSDT"
    let geckoId: String     // CoinGecko ID: "bitcoin"
    let name: String        // Display name: "Bitcoin"
    let ticker: String      // Short: "BTC"
    let color: Color

    var symbol: String { id }
}

enum Constants {
    static let binanceBaseURL = "https://data-api.binance.vision/api/v3"
    static let coingeckoBaseURL = "https://api.coingecko.com/api/v3"
    static let claudeAPIURL = "https://api.anthropic.com/v1/messages"
    static let claudeAPIVersion = "2023-06-01"
    static let defaultModel = "claude-sonnet-4-20250514"
    static let haikuModel = "claude-haiku-4-5-20251001"

    static let allCoins: [CoinDefinition] = [
        CoinDefinition(id: "BTCUSDT", geckoId: "bitcoin", name: "Bitcoin", ticker: "BTC", color: .orange),
        CoinDefinition(id: "ETHUSDT", geckoId: "ethereum", name: "Ethereum", ticker: "ETH", color: .indigo),
        CoinDefinition(id: "SOLUSDT", geckoId: "solana", name: "Solana", ticker: "SOL", color: .purple),
        CoinDefinition(id: "XRPUSDT", geckoId: "ripple", name: "XRP", ticker: "XRP", color: .gray),
        CoinDefinition(id: "ADAUSDT", geckoId: "cardano", name: "Cardano", ticker: "ADA", color: .blue),
        CoinDefinition(id: "DOTUSDT", geckoId: "polkadot", name: "Polkadot", ticker: "DOT", color: .pink),
        CoinDefinition(id: "AVAXUSDT", geckoId: "avalanche-2", name: "Avalanche", ticker: "AVAX", color: .red),
        CoinDefinition(id: "LINKUSDT", geckoId: "chainlink", name: "Chainlink", ticker: "LINK", color: .blue),
        CoinDefinition(id: "DOGEUSDT", geckoId: "dogecoin", name: "Dogecoin", ticker: "DOGE", color: .yellow),
        CoinDefinition(id: "MATICUSDT", geckoId: "matic-network", name: "Polygon", ticker: "MATIC", color: .purple),
        CoinDefinition(id: "NEARUSDT", geckoId: "near", name: "NEAR Protocol", ticker: "NEAR", color: .green),
        CoinDefinition(id: "UNIUSDT", geckoId: "uniswap", name: "Uniswap", ticker: "UNI", color: .pink),
        CoinDefinition(id: "AAVEUSDT", geckoId: "aave", name: "Aave", ticker: "AAVE", color: .cyan),
        CoinDefinition(id: "APTUSDT", geckoId: "aptos", name: "Aptos", ticker: "APT", color: .mint),
        CoinDefinition(id: "SUIUSDT", geckoId: "sui", name: "Sui", ticker: "SUI", color: .blue),
        CoinDefinition(id: "ARBUSDT", geckoId: "arbitrum", name: "Arbitrum", ticker: "ARB", color: .blue),
        CoinDefinition(id: "OPUSDT", geckoId: "optimism", name: "Optimism", ticker: "OP", color: .red),
        CoinDefinition(id: "FILUSDT", geckoId: "filecoin", name: "Filecoin", ticker: "FIL", color: .cyan),
        CoinDefinition(id: "LTCUSDT", geckoId: "litecoin", name: "Litecoin", ticker: "LTC", color: .gray),
        CoinDefinition(id: "ATOMUSDT", geckoId: "cosmos", name: "Cosmos", ticker: "ATOM", color: .indigo),
    ]

    static let supportedCoins: [(symbol: String, geckoId: String, name: String)] =
        allCoins.map { ($0.id, $0.geckoId, $0.name) }

    static func coin(for symbol: String) -> CoinDefinition? {
        allCoins.first { $0.id == symbol }
    }

    static let timeframes: [(interval: String, label: String)] = [
        ("1d", "Daily (Trend)"),
        ("4h", "4H (Directional Bias)"),
        ("1h", "1H (Entry)"),
    ]

    static let httpTimeout: TimeInterval = 15
    static let sentimentCacheDuration: TimeInterval = 300
}
