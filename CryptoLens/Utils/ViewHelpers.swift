import SwiftUI

// MARK: - Shared Bias & Time Helpers

/// Returns a color representing the bias direction, with Strong variants at full opacity
/// and regular variants slightly dimmed.
func biasColor(_ bias: String) -> Color {
    if bias.contains("Strong Bull") { return .green }
    if bias.contains("Bull") { return .green.opacity(0.7) }
    if bias.contains("Strong Bear") { return .red }
    if bias.contains("Bear") { return .red.opacity(0.7) }
    return .secondary
}

/// Simplified bias color that returns full-opacity green/red without Strong distinction.
func biasColorSimple(_ bias: String) -> Color {
    if bias.contains("Bullish") { return .green }
    if bias.contains("Bearish") { return .red }
    return .gray
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
