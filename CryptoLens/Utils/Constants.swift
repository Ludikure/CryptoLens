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
        // Mega-cap Tech
        AssetDefinition(id: "AAPL", name: "Apple", ticker: "AAPL", market: .stock, color: .gray),
        AssetDefinition(id: "MSFT", name: "Microsoft", ticker: "MSFT", market: .stock, color: .blue),
        AssetDefinition(id: "GOOGL", name: "Alphabet", ticker: "GOOGL", market: .stock, color: .green),
        AssetDefinition(id: "AMZN", name: "Amazon", ticker: "AMZN", market: .stock, color: .orange),
        AssetDefinition(id: "META", name: "Meta", ticker: "META", market: .stock, color: .blue),
        AssetDefinition(id: "NVDA", name: "NVIDIA", ticker: "NVDA", market: .stock, color: .green),
        AssetDefinition(id: "TSLA", name: "Tesla", ticker: "TSLA", market: .stock, color: .red),
        // Tech & Semis
        AssetDefinition(id: "AMD", name: "AMD", ticker: "AMD", market: .stock, color: .red),
        AssetDefinition(id: "AVGO", name: "Broadcom", ticker: "AVGO", market: .stock, color: .red),
        AssetDefinition(id: "TSM", name: "TSMC", ticker: "TSM", market: .stock, color: .blue),
        AssetDefinition(id: "INTC", name: "Intel", ticker: "INTC", market: .stock, color: .blue),
        AssetDefinition(id: "ORCL", name: "Oracle", ticker: "ORCL", market: .stock, color: .red),
        AssetDefinition(id: "CRM", name: "Salesforce", ticker: "CRM", market: .stock, color: .blue),
        AssetDefinition(id: "ADBE", name: "Adobe", ticker: "ADBE", market: .stock, color: .red),
        AssetDefinition(id: "NFLX", name: "Netflix", ticker: "NFLX", market: .stock, color: .red),
        AssetDefinition(id: "PLTR", name: "Palantir", ticker: "PLTR", market: .stock, color: .indigo),
        AssetDefinition(id: "SHOP", name: "Shopify", ticker: "SHOP", market: .stock, color: .green),
        AssetDefinition(id: "SNOW", name: "Snowflake", ticker: "SNOW", market: .stock, color: .cyan),
        AssetDefinition(id: "UBER", name: "Uber", ticker: "UBER", market: .stock, color: .gray),
        // Crypto-adjacent
        AssetDefinition(id: "COIN", name: "Coinbase", ticker: "COIN", market: .stock, color: .blue),
        AssetDefinition(id: "MSTR", name: "MicroStrategy", ticker: "MSTR", market: .stock, color: .red),
        // Finance
        AssetDefinition(id: "JPM", name: "JPMorgan Chase", ticker: "JPM", market: .stock, color: .blue),
        AssetDefinition(id: "V", name: "Visa", ticker: "V", market: .stock, color: .blue),
        AssetDefinition(id: "MA", name: "Mastercard", ticker: "MA", market: .stock, color: .orange),
        AssetDefinition(id: "BAC", name: "Bank of America", ticker: "BAC", market: .stock, color: .red),
        AssetDefinition(id: "GS", name: "Goldman Sachs", ticker: "GS", market: .stock, color: .blue),
        // Healthcare
        AssetDefinition(id: "UNH", name: "UnitedHealth", ticker: "UNH", market: .stock, color: .blue),
        AssetDefinition(id: "JNJ", name: "Johnson & Johnson", ticker: "JNJ", market: .stock, color: .red),
        AssetDefinition(id: "LLY", name: "Eli Lilly", ticker: "LLY", market: .stock, color: .red),
        AssetDefinition(id: "PFE", name: "Pfizer", ticker: "PFE", market: .stock, color: .blue),
        AssetDefinition(id: "ABBV", name: "AbbVie", ticker: "ABBV", market: .stock, color: .indigo),
        // Consumer
        AssetDefinition(id: "WMT", name: "Walmart", ticker: "WMT", market: .stock, color: .blue),
        AssetDefinition(id: "COST", name: "Costco", ticker: "COST", market: .stock, color: .red),
        AssetDefinition(id: "HD", name: "Home Depot", ticker: "HD", market: .stock, color: .orange),
        AssetDefinition(id: "DIS", name: "Disney", ticker: "DIS", market: .stock, color: .blue),
        AssetDefinition(id: "NKE", name: "Nike", ticker: "NKE", market: .stock, color: .orange),
        AssetDefinition(id: "SBUX", name: "Starbucks", ticker: "SBUX", market: .stock, color: .green),
        AssetDefinition(id: "MCD", name: "McDonald's", ticker: "MCD", market: .stock, color: .yellow),
        AssetDefinition(id: "KO", name: "Coca-Cola", ticker: "KO", market: .stock, color: .red),
        AssetDefinition(id: "PEP", name: "PepsiCo", ticker: "PEP", market: .stock, color: .blue),
        // Industrial / Energy
        AssetDefinition(id: "BA", name: "Boeing", ticker: "BA", market: .stock, color: .blue),
        AssetDefinition(id: "CAT", name: "Caterpillar", ticker: "CAT", market: .stock, color: .yellow),
        AssetDefinition(id: "XOM", name: "ExxonMobil", ticker: "XOM", market: .stock, color: .red),
        AssetDefinition(id: "CVX", name: "Chevron", ticker: "CVX", market: .stock, color: .blue),
        // Telecom
        AssetDefinition(id: "T", name: "AT&T", ticker: "T", market: .stock, color: .cyan),
        AssetDefinition(id: "VZ", name: "Verizon", ticker: "VZ", market: .stock, color: .red),
        // ETFs — Index
        AssetDefinition(id: "SPY", name: "S&P 500 ETF", ticker: "SPY", market: .stock, color: .indigo),
        AssetDefinition(id: "QQQ", name: "Nasdaq 100 ETF", ticker: "QQQ", market: .stock, color: .purple),
        AssetDefinition(id: "IWM", name: "Russell 2000 ETF", ticker: "IWM", market: .stock, color: .brown),
        AssetDefinition(id: "DIA", name: "Dow Jones ETF", ticker: "DIA", market: .stock, color: .blue),
        AssetDefinition(id: "VOO", name: "Vanguard S&P 500", ticker: "VOO", market: .stock, color: .indigo),
        AssetDefinition(id: "VTI", name: "Vanguard Total Market", ticker: "VTI", market: .stock, color: .indigo),
        // ETFs — Sector & Asset
        AssetDefinition(id: "GLD", name: "Gold ETF", ticker: "GLD", market: .stock, color: .yellow),
        AssetDefinition(id: "TLT", name: "20+ Year Treasury", ticker: "TLT", market: .stock, color: .cyan),
        AssetDefinition(id: "XLF", name: "Financial Sector ETF", ticker: "XLF", market: .stock, color: .green),
        AssetDefinition(id: "XLE", name: "Energy Sector ETF", ticker: "XLE", market: .stock, color: .orange),
        AssetDefinition(id: "XLK", name: "Tech Sector ETF", ticker: "XLK", market: .stock, color: .purple),
        AssetDefinition(id: "ARKK", name: "ARK Innovation ETF", ticker: "ARKK", market: .stock, color: .orange),
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
