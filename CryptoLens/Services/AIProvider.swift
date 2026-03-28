import Foundation

/// Abstraction for AI analysis providers (Claude, Gemini, etc.)
protocol AIProvider {
    var displayName: String { get }
    func analyze(indicators: [IndicatorResult], sentiment: CoinInfo?, symbol: String, market: Market, stockInfo: StockInfo?) async throws -> ClaudeAnalysisResponse
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
            (Constants.defaultModel, "Sonnet (recommended)"),
            (Constants.haikuModel, "Haiku (faster, cheaper)"),
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
