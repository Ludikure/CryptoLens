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
        CoinDefinition(id: "POLUSDT", geckoId: "matic-network", name: "Polygon", ticker: "POL", color: .purple),
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
        // Magnificent 7
        AssetDefinition(id: "AAPL", name: "Apple", ticker: "AAPL", market: .stock, color: .gray),
        AssetDefinition(id: "MSFT", name: "Microsoft", ticker: "MSFT", market: .stock, color: .blue),
        AssetDefinition(id: "GOOGL", name: "Alphabet", ticker: "GOOGL", market: .stock, color: .green),
        AssetDefinition(id: "AMZN", name: "Amazon", ticker: "AMZN", market: .stock, color: .orange),
        AssetDefinition(id: "META", name: "Meta", ticker: "META", market: .stock, color: .blue),
        AssetDefinition(id: "NVDA", name: "NVIDIA", ticker: "NVDA", market: .stock, color: .green),
        AssetDefinition(id: "TSLA", name: "Tesla", ticker: "TSLA", market: .stock, color: .red),
        // Semiconductors
        AssetDefinition(id: "AMD", name: "AMD", ticker: "AMD", market: .stock, color: .red),
        AssetDefinition(id: "AVGO", name: "Broadcom", ticker: "AVGO", market: .stock, color: .red),
        AssetDefinition(id: "TSM", name: "TSMC", ticker: "TSM", market: .stock, color: .blue),
        AssetDefinition(id: "INTC", name: "Intel", ticker: "INTC", market: .stock, color: .blue),
        AssetDefinition(id: "QCOM", name: "Qualcomm", ticker: "QCOM", market: .stock, color: .blue),
        AssetDefinition(id: "MU", name: "Micron", ticker: "MU", market: .stock, color: .blue),
        AssetDefinition(id: "ARM", name: "ARM Holdings", ticker: "ARM", market: .stock, color: .cyan),
        AssetDefinition(id: "MRVL", name: "Marvell", ticker: "MRVL", market: .stock, color: .red),
        // Software & Cloud
        AssetDefinition(id: "ORCL", name: "Oracle", ticker: "ORCL", market: .stock, color: .red),
        AssetDefinition(id: "CRM", name: "Salesforce", ticker: "CRM", market: .stock, color: .blue),
        AssetDefinition(id: "ADBE", name: "Adobe", ticker: "ADBE", market: .stock, color: .red),
        AssetDefinition(id: "NFLX", name: "Netflix", ticker: "NFLX", market: .stock, color: .red),
        AssetDefinition(id: "PLTR", name: "Palantir", ticker: "PLTR", market: .stock, color: .indigo),
        AssetDefinition(id: "SHOP", name: "Shopify", ticker: "SHOP", market: .stock, color: .green),
        AssetDefinition(id: "SNOW", name: "Snowflake", ticker: "SNOW", market: .stock, color: .cyan),
        AssetDefinition(id: "UBER", name: "Uber", ticker: "UBER", market: .stock, color: .gray),
        AssetDefinition(id: "NOW", name: "ServiceNow", ticker: "NOW", market: .stock, color: .green),
        AssetDefinition(id: "PANW", name: "Palo Alto Networks", ticker: "PANW", market: .stock, color: .red),
        AssetDefinition(id: "CRWD", name: "CrowdStrike", ticker: "CRWD", market: .stock, color: .red),
        AssetDefinition(id: "NET", name: "Cloudflare", ticker: "NET", market: .stock, color: .orange),
        AssetDefinition(id: "DDOG", name: "Datadog", ticker: "DDOG", market: .stock, color: .purple),
        AssetDefinition(id: "ZS", name: "Zscaler", ticker: "ZS", market: .stock, color: .blue),
        AssetDefinition(id: "SPOT", name: "Spotify", ticker: "SPOT", market: .stock, color: .green),
        AssetDefinition(id: "SQ", name: "Block (Square)", ticker: "SQ", market: .stock, color: .gray),
        AssetDefinition(id: "ABNB", name: "Airbnb", ticker: "ABNB", market: .stock, color: .red),
        AssetDefinition(id: "DASH", name: "DoorDash", ticker: "DASH", market: .stock, color: .red),
        // AI, Robotics & eVTOL
        AssetDefinition(id: "SMCI", name: "Super Micro", ticker: "SMCI", market: .stock, color: .green),
        AssetDefinition(id: "ACHR", name: "Archer Aviation", ticker: "ACHR", market: .stock, color: .blue),
        AssetDefinition(id: "AI", name: "C3.ai", ticker: "AI", market: .stock, color: .blue),
        AssetDefinition(id: "IONQ", name: "IonQ", ticker: "IONQ", market: .stock, color: .purple),
        // Crypto-adjacent
        AssetDefinition(id: "COIN", name: "Coinbase", ticker: "COIN", market: .stock, color: .blue),
        AssetDefinition(id: "MSTR", name: "MicroStrategy", ticker: "MSTR", market: .stock, color: .red),
        AssetDefinition(id: "MARA", name: "Marathon Digital", ticker: "MARA", market: .stock, color: .indigo),
        AssetDefinition(id: "RIOT", name: "Riot Platforms", ticker: "RIOT", market: .stock, color: .blue),
        // Finance
        AssetDefinition(id: "JPM", name: "JPMorgan Chase", ticker: "JPM", market: .stock, color: .blue),
        AssetDefinition(id: "V", name: "Visa", ticker: "V", market: .stock, color: .blue),
        AssetDefinition(id: "MA", name: "Mastercard", ticker: "MA", market: .stock, color: .orange),
        AssetDefinition(id: "BAC", name: "Bank of America", ticker: "BAC", market: .stock, color: .red),
        AssetDefinition(id: "GS", name: "Goldman Sachs", ticker: "GS", market: .stock, color: .blue),
        AssetDefinition(id: "MS", name: "Morgan Stanley", ticker: "MS", market: .stock, color: .blue),
        AssetDefinition(id: "WFC", name: "Wells Fargo", ticker: "WFC", market: .stock, color: .red),
        AssetDefinition(id: "C", name: "Citigroup", ticker: "C", market: .stock, color: .blue),
        AssetDefinition(id: "SCHW", name: "Charles Schwab", ticker: "SCHW", market: .stock, color: .blue),
        AssetDefinition(id: "BLK", name: "BlackRock", ticker: "BLK", market: .stock, color: .gray),
        AssetDefinition(id: "AXP", name: "American Express", ticker: "AXP", market: .stock, color: .blue),
        AssetDefinition(id: "PYPL", name: "PayPal", ticker: "PYPL", market: .stock, color: .blue),
        // Healthcare & Pharma
        AssetDefinition(id: "UNH", name: "UnitedHealth", ticker: "UNH", market: .stock, color: .blue),
        AssetDefinition(id: "JNJ", name: "Johnson & Johnson", ticker: "JNJ", market: .stock, color: .red),
        AssetDefinition(id: "LLY", name: "Eli Lilly", ticker: "LLY", market: .stock, color: .red),
        AssetDefinition(id: "PFE", name: "Pfizer", ticker: "PFE", market: .stock, color: .blue),
        AssetDefinition(id: "ABBV", name: "AbbVie", ticker: "ABBV", market: .stock, color: .indigo),
        AssetDefinition(id: "MRK", name: "Merck", ticker: "MRK", market: .stock, color: .cyan),
        AssetDefinition(id: "TMO", name: "Thermo Fisher", ticker: "TMO", market: .stock, color: .blue),
        AssetDefinition(id: "ABT", name: "Abbott Labs", ticker: "ABT", market: .stock, color: .blue),
        AssetDefinition(id: "NVO", name: "Novo Nordisk", ticker: "NVO", market: .stock, color: .blue),
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
        AssetDefinition(id: "PG", name: "Procter & Gamble", ticker: "PG", market: .stock, color: .blue),
        AssetDefinition(id: "TGT", name: "Target", ticker: "TGT", market: .stock, color: .red),
        AssetDefinition(id: "LOW", name: "Lowe's", ticker: "LOW", market: .stock, color: .blue),
        // Industrial / Defense
        AssetDefinition(id: "BA", name: "Boeing", ticker: "BA", market: .stock, color: .blue),
        AssetDefinition(id: "CAT", name: "Caterpillar", ticker: "CAT", market: .stock, color: .yellow),
        AssetDefinition(id: "GE", name: "GE Aerospace", ticker: "GE", market: .stock, color: .blue),
        AssetDefinition(id: "RTX", name: "RTX (Raytheon)", ticker: "RTX", market: .stock, color: .blue),
        AssetDefinition(id: "LMT", name: "Lockheed Martin", ticker: "LMT", market: .stock, color: .gray),
        AssetDefinition(id: "UPS", name: "UPS", ticker: "UPS", market: .stock, color: .brown),
        AssetDefinition(id: "DE", name: "Deere & Co", ticker: "DE", market: .stock, color: .green),
        // Energy
        AssetDefinition(id: "XOM", name: "ExxonMobil", ticker: "XOM", market: .stock, color: .red),
        AssetDefinition(id: "CVX", name: "Chevron", ticker: "CVX", market: .stock, color: .blue),
        AssetDefinition(id: "COP", name: "ConocoPhillips", ticker: "COP", market: .stock, color: .red),
        AssetDefinition(id: "SLB", name: "Schlumberger", ticker: "SLB", market: .stock, color: .blue),
        // Telecom & Utilities
        AssetDefinition(id: "T", name: "AT&T", ticker: "T", market: .stock, color: .cyan),
        AssetDefinition(id: "VZ", name: "Verizon", ticker: "VZ", market: .stock, color: .red),
        AssetDefinition(id: "TMUS", name: "T-Mobile", ticker: "TMUS", market: .stock, color: .pink),
        AssetDefinition(id: "NEE", name: "NextEra Energy", ticker: "NEE", market: .stock, color: .blue),
        // Chinese ADRs
        AssetDefinition(id: "BABA", name: "Alibaba", ticker: "BABA", market: .stock, color: .orange),
        AssetDefinition(id: "NIO", name: "NIO", ticker: "NIO", market: .stock, color: .blue),
        AssetDefinition(id: "PDD", name: "PDD Holdings", ticker: "PDD", market: .stock, color: .orange),
        AssetDefinition(id: "JD", name: "JD.com", ticker: "JD", market: .stock, color: .red),
        // Meme / Retail favorites
        AssetDefinition(id: "GME", name: "GameStop", ticker: "GME", market: .stock, color: .red),
        AssetDefinition(id: "AMC", name: "AMC Entertainment", ticker: "AMC", market: .stock, color: .red),
        AssetDefinition(id: "SOFI", name: "SoFi Technologies", ticker: "SOFI", market: .stock, color: .cyan),
        // ETFs — Index
        AssetDefinition(id: "SPY", name: "S&P 500 ETF", ticker: "SPY", market: .stock, color: .indigo),
        AssetDefinition(id: "QQQ", name: "Nasdaq 100 ETF", ticker: "QQQ", market: .stock, color: .purple),
        AssetDefinition(id: "IWM", name: "Russell 2000 ETF", ticker: "IWM", market: .stock, color: .brown),
        AssetDefinition(id: "DIA", name: "Dow Jones ETF", ticker: "DIA", market: .stock, color: .blue),
        AssetDefinition(id: "VOO", name: "Vanguard S&P 500", ticker: "VOO", market: .stock, color: .indigo),
        AssetDefinition(id: "VTI", name: "Vanguard Total Market", ticker: "VTI", market: .stock, color: .indigo),
        // ETFs — Sector & Thematic
        AssetDefinition(id: "GLD", name: "Gold ETF", ticker: "GLD", market: .stock, color: .yellow),
        AssetDefinition(id: "SLV", name: "Silver ETF", ticker: "SLV", market: .stock, color: .gray),
        AssetDefinition(id: "TLT", name: "20+ Year Treasury", ticker: "TLT", market: .stock, color: .cyan),
        AssetDefinition(id: "XLF", name: "Financial Sector", ticker: "XLF", market: .stock, color: .green),
        AssetDefinition(id: "XLE", name: "Energy Sector", ticker: "XLE", market: .stock, color: .orange),
        AssetDefinition(id: "XLK", name: "Tech Sector", ticker: "XLK", market: .stock, color: .purple),
        AssetDefinition(id: "XLV", name: "Healthcare Sector", ticker: "XLV", market: .stock, color: .blue),
        AssetDefinition(id: "ARKK", name: "ARK Innovation", ticker: "ARKK", market: .stock, color: .orange),
        AssetDefinition(id: "SMH", name: "Semiconductor ETF", ticker: "SMH", market: .stock, color: .indigo),
        AssetDefinition(id: "SOXX", name: "iShares Semiconductor", ticker: "SOXX", market: .stock, color: .blue),
    ]

    // MARK: - Custom stocks (set by FavoritesStore on init)

    @MainActor static var customStocks: [AssetDefinition] = []

    // MARK: - Unified lookups

    static let supportedCoins: [(symbol: String, geckoId: String, name: String)] =
        allCoins.map { ($0.id, $0.geckoId, $0.name) }

    static func coin(for symbol: String) -> CoinDefinition? {
        allCoins.first { $0.id == symbol }
    }

    @MainActor static func stock(for symbol: String) -> AssetDefinition? {
        if let s = defaultStocks.first(where: { $0.id == symbol }) { return s }
        return customStocks.first { $0.id == symbol }
    }

    @MainActor static func asset(for symbol: String) -> (name: String, ticker: String, market: Market)? {
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
