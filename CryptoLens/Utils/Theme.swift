import SwiftUI
import UIKit   // UIColor — the adaptive light/dark provider below has no SwiftUI-native equivalent

/// Single source of truth for the app's semantic colours, small-text scale and card chrome.
///
/// Before this existed there were ~34 ad-hoc `Color.red` / `.green` / `.orange` uses spread across
/// the view layer with no shared definition, so the same idea (bullish, caution, danger) was drawn
/// slightly differently in every card — the main reason a screen of individually-fine cards didn't
/// read as one designed product. It also meant dark-mode contrast had to be fixed 34 times.
///
/// Colours are ADAPTIVE: SwiftUI's stock `.green`/`.red` are tuned for light backgrounds and go
/// muddy-to-glaring on dark, which matters here because the app is mostly used in dark mode. Each
/// role below carries a hand-picked pair — a deeper, less shouty tone on light, a brighter and
/// desaturated one on dark, both kept clear of pure hue.
enum Theme {

    // MARK: - Semantic colours

    /// Price/bias up, wins, confirmations.
    static let bullish = adaptive(light: (0.06, 0.59, 0.41), dark: (0.20, 0.83, 0.60))
    /// Price/bias down, losses, invalidation.
    static let bearish = adaptive(light: (0.81, 0.16, 0.16), dark: (0.97, 0.44, 0.44))
    /// "Careful" — elevated risk, chase warnings, staleness. NOT an error.
    static let caution = adaptive(light: (0.71, 0.33, 0.04), dark: (0.98, 0.57, 0.24))
    /// Hard stop — kill conditions, invalid geometry, failures.
    static let danger = adaptive(light: (0.75, 0.11, 0.16), dark: (1.00, 0.42, 0.42))
    /// Informational accents (levels, entries, neutral emphasis).
    static let info = adaptive(light: (0.11, 0.31, 0.85), dark: (0.38, 0.65, 0.98))
    /// Nothing doing — no edge, flat, unknown.
    static let neutral = Color.secondary

    /// The colour for a signed number, with a genuine zero reading as neutral rather than green.
    static func forChange(_ value: Double?) -> Color {
        guard let v = value, v != 0 else { return neutral }
        return v > 0 ? bullish : bearish
    }

    /// Colour for a bias label ("Strong Bullish", "Bearish", …). The Strong variants read at full
    /// strength, plain variants slightly dimmed, so the tier is visible without reading the text.
    static func forBias(_ bias: String) -> Color {
        if bias.contains("Strong Bull") { return bullish }
        if bias.contains("Bull") { return bullish.opacity(0.75) }
        if bias.contains("Strong Bear") { return bearish }
        if bias.contains("Bear") { return bearish.opacity(0.75) }
        return neutral
    }

    // MARK: - Type scale

    /// Tiny labels (badges, pill captions). These are TEXT STYLES, not fixed point sizes: a
    /// `.system(size: 9)` never scales with Dynamic Type, which is what the ~30 hardcoded sizes in
    /// the view layer were doing — 8-9pt text, below the legible floor, frozen for every user
    /// regardless of their accessibility setting. `.caption2` bases at 11pt and grows.
    static let micro = Font.caption2.weight(.semibold)
    /// Supporting text — the floor for anything the user actually has to read.
    static let caption = Font.caption
    /// Numbers that should line up in columns and never reflow between digits.
    static let mono = Font.system(.footnote, design: .monospaced)
    /// The single big number on a card. Scales, unlike a bare `.system(size: 34)`.
    static let headlineNumber = Font.system(.largeTitle, design: .rounded).weight(.bold)
    /// Decorative glyph for empty states.
    static let emptyGlyph = Font.system(.largeTitle, design: .rounded)

    // MARK: - Chrome

    static let cardRadius: CGFloat = 14
    static let cardPadding: CGFloat = 14

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

// MARK: - Card chrome

/// Consistent card surface: one radius, one padding, one background, a hairline border that only
/// shows where it's needed, and an optional semantic accent stripe down the leading edge.
struct ThemedCard: ViewModifier {
    var accent: Color? = nil

    func body(content: Content) -> some View {
        content
            .padding(Theme.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay(alignment: .leading) {
                if let accent {
                    // A 3pt stripe carries the card's verdict pre-attentively — you know the answer
                    // before reading a word.
                    Rectangle().fill(accent).frame(width: 3)
                        .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
                        .padding(.vertical, 6)
                        .padding(.leading, 1)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
            )
    }
}

extension View {
    /// Applies the shared card surface. Pass an accent to add the leading verdict stripe.
    func themedCard(accent: Color? = nil) -> some View {
        modifier(ThemedCard(accent: accent))
    }

    /// A compact semantic pill — the shape used for regime/bias/state badges.
    func themedPill(_ color: Color) -> some View {
        self
            .font(Theme.micro)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}
