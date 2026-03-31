import Foundation

/// Abstraction for AI analysis providers (Claude, Gemini, etc.)
protocol AIProvider {
    var displayName: String { get }
    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market, stockInfo: StockInfo?, derivatives: DerivativesData?, positioning: PositioningSnapshot?, stockSentiment: StockSentimentData?, economicEvents: [EconomicEvent], macro: MacroSnapshot?, weeklyContext: String?, spyContext: String?, spotPressure: SpotPressure?) async throws -> ClaudeAnalysisResponse
}

enum AIProviderType: String, Codable, CaseIterable, Identifiable {
    case claude = "claude"
    case gemini = "gemini"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claude: return "Claude (Anthropic)"
        case .gemini: return "Gemini (Google)"
        }
    }

    var models: [(id: String, name: String)] {
        switch self {
        case .claude: return [
            ("claude-sonnet-4-6", "Sonnet 4.6 (recommended)"),
            ("claude-opus-4-6", "Opus 4.6 (most capable)"),
            (Constants.haikuModel, "Haiku 4.5 (faster, cheaper)"),
        ]
        case .gemini: return [
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ]
        }
    }

    var keychainKey: String {
        switch self {
        case .claude: return "claude_api_key"
        case .gemini: return "gemini_api_key"
        }
    }

    var infoPlistKey: String {
        switch self {
        case .claude: return "ClaudeAPIKey"
        case .gemini: return "GeminiAPIKey"
        }
    }
}
