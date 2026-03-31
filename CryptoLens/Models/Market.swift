import Foundation
import SwiftUI

enum Market: String, Codable, CaseIterable, Identifiable {
    case crypto
    case stock

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .crypto: return "Crypto"
        case .stock: return "Stocks"
        }
    }

    var timeframes: [(interval: String, label: String)] {
        switch self {
        case .crypto: return [("1d", "Daily (Trend)"), ("4h", "4H (Bias)"), ("1h", "1H (Entry)")]
        case .stock: return [("1d", "Daily (Trend)"), ("4h", "4H (Bias)"), ("1h", "1H (Entry)")]
        }
    }
}

/// Unified asset definition for both crypto and stocks.
struct AssetDefinition: Identifiable, Equatable, Codable {
    let id: String          // "BTCUSDT" or "AAPL"
    let name: String        // "Bitcoin" or "Apple Inc."
    let ticker: String      // "BTC" or "AAPL"
    let market: Market
    let colorHex: String    // Stored as hex for Codable

    var symbol: String { id }

    var color: Color {
        Color(hex: colorHex)
    }

    init(id: String, name: String, ticker: String, market: Market, color: Color) {
        self.id = id
        self.name = name
        self.ticker = ticker
        self.market = market
        self.colorHex = color.toHex()
    }
}

// MARK: - Color hex helpers

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: .alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }

    func toHex() -> String {
        guard let components = UIColor(self).cgColor.components, components.count >= 3 else { return "808080" }
        let r = Int(components[0] * 255)
        let g = Int(components[1] * 255)
        let b = Int(components[2] * 255)
        return String(format: "%02X%02X%02X", r, g, b)
    }
}
