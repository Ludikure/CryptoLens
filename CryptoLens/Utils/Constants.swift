import Foundation
import SwiftUI

// Keep CoinDefinition for backward compat during transition
struct CoinDefinition: Identifiable, Equatable {
    let id: String
    let geckoId: String
    let name: String
    let ticker: String
    let color: Color

    var symbol: String { id }
}

enum Constants {
    static let binanceBaseURL = "https://data-api.binance.vision/api/v3"
    static let coingeckoBaseURL = "https://api.coingecko.com/api/v3"
    static let yahooBaseURL = "https://query1.finance.yahoo.com"
    static let claudeAPIURL = "https://api.anthropic.com/v1/messages"
    static let claudeAPIVersion = "2023-06-01"
    static let defaultModel = "claude-sonnet-4-6"
    static let haikuModel = "claude-haiku-4-5-20251001"

    // MARK: - Crypto

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

    // MARK: - Stocks

    static let defaultStocks: [AssetDefinition] = [
        AssetDefinition(id: "AAPL", name: "Apple", ticker: "AAPL", market: .stock, color: .gray),
        AssetDefinition(id: "MSFT", name: "Microsoft", ticker: "MSFT", market: .stock, color: .blue),
        AssetDefinition(id: "GOOGL", name: "Alphabet", ticker: "GOOGL", market: .stock, color: .green),
        AssetDefinition(id: "AMZN", name: "Amazon", ticker: "AMZN", market: .stock, color: .orange),
        AssetDefinition(id: "TSLA", name: "Tesla", ticker: "TSLA", market: .stock, color: .red),
        AssetDefinition(id: "NVDA", name: "NVIDIA", ticker: "NVDA", market: .stock, color: .green),
        AssetDefinition(id: "META", name: "Meta", ticker: "META", market: .stock, color: .blue),
        AssetDefinition(id: "PLTR", name: "Palantir", ticker: "PLTR", market: .stock, color: .indigo),
        AssetDefinition(id: "AMD", name: "AMD", ticker: "AMD", market: .stock, color: .red),
        AssetDefinition(id: "NFLX", name: "Netflix", ticker: "NFLX", market: .stock, color: .red),
        AssetDefinition(id: "CRM", name: "Salesforce", ticker: "CRM", market: .stock, color: .blue),
        AssetDefinition(id: "COIN", name: "Coinbase", ticker: "COIN", market: .stock, color: .blue),
        AssetDefinition(id: "MSTR", name: "MicroStrategy", ticker: "MSTR", market: .stock, color: .red),
        AssetDefinition(id: "SPY", name: "S&P 500 ETF", ticker: "SPY", market: .stock, color: .indigo),
        AssetDefinition(id: "QQQ", name: "Nasdaq 100 ETF", ticker: "QQQ", market: .stock, color: .purple),
        AssetDefinition(id: "IWM", name: "Russell 2000 ETF", ticker: "IWM", market: .stock, color: .brown),
        AssetDefinition(id: "DIA", name: "Dow Jones ETF", ticker: "DIA", market: .stock, color: .blue),
        AssetDefinition(id: "GLD", name: "Gold ETF", ticker: "GLD", market: .stock, color: .yellow),
        AssetDefinition(id: "TLT", name: "20+ Year Treasury", ticker: "TLT", market: .stock, color: .cyan),
        AssetDefinition(id: "XLF", name: "Financial Sector ETF", ticker: "XLF", market: .stock, color: .green),
        AssetDefinition(id: "XLE", name: "Energy Sector ETF", ticker: "XLE", market: .stock, color: .orange),
    ]

    // MARK: - Custom stocks (set by FavoritesStore on init)

    static var customStocks: [AssetDefinition] = []

    // MARK: - Unified lookups

    static let supportedCoins: [(symbol: String, geckoId: String, name: String)] =
        allCoins.map { ($0.id, $0.geckoId, $0.name) }

    static func coin(for symbol: String) -> CoinDefinition? {
        allCoins.first { $0.id == symbol }
    }

    static func stock(for symbol: String) -> AssetDefinition? {
        if let s = defaultStocks.first(where: { $0.id == symbol }) { return s }
        return customStocks.first { $0.id == symbol }
    }

    static func asset(for symbol: String) -> (name: String, ticker: String, market: Market)? {
        if let c = coin(for: symbol) { return (c.name, c.ticker, .crypto) }
        if let s = stock(for: symbol) { return (s.name, s.ticker, .stock) }
        return nil
    }

    static let timeframes: [(interval: String, label: String)] = [
        ("1d", "Daily (Trend)"),
        ("4h", "4H (Directional Bias)"),
        ("1h", "1H (Entry)"),
    ]

    static let httpTimeout: TimeInterval = 15
    static let sentimentCacheDuration: TimeInterval = 300
}
