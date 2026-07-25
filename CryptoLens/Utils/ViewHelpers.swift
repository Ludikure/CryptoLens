import SwiftUI

// MARK: - Shared Bias & Time Helpers

/// Returns a color representing the bias direction, with Strong variants at full opacity
/// and regular variants slightly dimmed.
///
/// Delegates to `Theme` (2026-07-24) so every existing call site picks up the shared, dark-mode-tuned
/// palette without being touched individually.
func biasColor(_ bias: String) -> Color {
    Theme.forBias(bias)
}

/// Simplified bias color without the Strong distinction. Also theme-backed; note this returns
/// `Theme.neutral` (secondary) rather than the old flat `.gray`, which was invisible on dark.
func biasColorSimple(_ bias: String) -> Color {
    if bias.contains("Bullish") { return Theme.bullish }
    if bias.contains("Bearish") { return Theme.bearish }
    return Theme.neutral
}

/// Shortens bias labels for compact display.
func shortBias(_ bias: String) -> String {
    switch bias {
    case "Strong Bullish": return "Strong Bull"
    case "Bullish": return "Bullish"
    case "Strong Bearish": return "Strong Bear"
    case "Bearish": return "Bearish"
    default: return "Neutral"
    }
}

/// Returns a human-readable relative time string (e.g., "5m ago", "3h ago", "2d ago").
func timeAgo(_ date: Date) -> String {
    let interval = Date().timeIntervalSince(date)
    if interval < 3600 { return "\(Int(interval / 60))m ago" }
    if interval < 86400 { return "\(Int(interval / 3600))h ago" }
    return "\(Int(interval / 86400))d ago"
}
