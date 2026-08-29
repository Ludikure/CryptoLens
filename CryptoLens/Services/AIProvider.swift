import Foundation

/// AI provider selection. The actual analysis call runs server-side via the Worker
/// `/full-analysis` endpoint (see `WorkerFullAnalysisService`); this enum only carries
/// the user's provider/model choice and the per-provider model allowlist + key lookups.
enum AIProviderType: String, Codable, CaseIterable, Identifiable {
    case claude = "claude"
    case gemini = "gemini"
    case deepseek = "deepseek"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claude: return "Claude (Anthropic)"
        case .gemini: return "Gemini (Google)"
        case .deepseek: return "DeepSeek"
        }
    }

    /// Model identifiers may carry an optional "@thinking-N" suffix where N is the thinking-budget
    /// token count. ClaudeService parses this and forwards as a separate parameter to the worker;
    /// the worker translates to Anthropic's `thinking: { type: "enabled", budget_tokens: N }`.
    /// Extended thinking lifts smaller models to near-flagship quality on rule-based tasks
    /// (our prompt's checkbox-based conviction calibration + 7-point self-check qualify) at lower
    /// cost than the next tier up.
    var models: [(id: String, name: String)] {
        switch self {
        // NB: the "@thinking-N" suffix is now just an ON/OFF signal. On Sonnet 5 / Opus 4.7 the
        // worker uses adaptive thinking + `effort: high` (manual budget_tokens 400s on those); the
        // number is only honored on the legacy Sonnet 4.6 / Opus 4.6 budget path.
        case .claude: return [
            ("claude-sonnet-5@thinking-8000", "Sonnet 5 + Extended Thinking (recommended)"),
            ("claude-sonnet-5", "Sonnet 5 (faster, no thinking)"),
            ("claude-sonnet-4-6@thinking-8000", "Sonnet 4.6 + Extended Thinking"),
            ("claude-sonnet-4-6", "Sonnet 4.6 (faster, no thinking)"),
            ("claude-opus-4-7@thinking-10000", "Opus 4.7 + Extended Thinking (max quality)"),
            ("claude-opus-4-7", "Opus 4.7"),
            ("claude-opus-4-6@thinking-10000", "Opus 4.6 + Extended Thinking"),
            ("claude-opus-4-6", "Opus 4.6"),
            (Constants.haikuModel, "Haiku 4.5 (fastest, cheapest)"),
        ]
        case .gemini: return [
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash (fast)"),
        ]
        case .deepseek: return [
            // R1 is the reasoning-tuned model — exposes a `reasoning_content` field with its
            // thinking, then a final answer. Strong fit for our rule-based prompt at ~6x cheaper
            // than Sonnet 4.6.
            ("deepseek-reasoner", "DeepSeek R1 (reasoning, cheap)"),
            ("deepseek-chat", "DeepSeek V3 (general purpose)"),
        ]
        }
    }

    var keychainKey: String {
        switch self {
        case .claude: return "claude_api_key"
        case .gemini: return "gemini_api_key"
        case .deepseek: return "deepseek_api_key"
        }
    }

    var infoPlistKey: String {
        switch self {
        case .claude: return "ClaudeAPIKey"
        case .gemini: return "GeminiAPIKey"
        case .deepseek: return "DeepSeekAPIKey"
        }
    }
}
