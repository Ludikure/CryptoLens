import Foundation
import WidgetKit

/// Publishes the favorites snapshot the home-screen widget renders.
///
/// The widget (`MarketScopeWidget.swift:42`) has always read `widget_data` from the
/// `group.com.ludikure.CryptoLens` App Group container — but nothing ever wrote it, and the main app
/// didn't even declare the group, so the widget was permanently blank. This is the missing writer.
///
/// The payload shape is dictated by the widget's private `SharedAsset` decoder; keep the two in sync.
/// Writes are cheap and idempotent, and skipped entirely when nothing changed, so this is safe to
/// call after every refresh.
enum WidgetDataWriter {

    private static let suiteName = "group.com.ludikure.CryptoLens"
    private static let dataKey = "widget_data"

    /// Mirrors the widget's `SharedAsset` exactly — field names are the wire format.
    private struct SharedAsset: Codable {
        let symbol: String
        let ticker: String
        let price: Double
        let bias: String
        let change24h: Double?
        let timestamp: Date
    }

    /// Write the favorites the app currently has cached results for, in the user's own order.
    /// Symbols without a cached result are skipped rather than written as zeroes — a blank row is
    /// worse than a shorter list. Capped at 6: no widget family shows more, and the group container
    /// is not a cache.
    static func write(favorites: [String], results: [String: AnalysisResult]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }   // group unavailable

        let assets: [SharedAsset] = favorites.prefix(12).compactMap { symbol in
            guard let r = results[symbol] else { return nil }
            let price = r.tf1.price
            guard price > 0 else { return nil }
            return SharedAsset(
                symbol: symbol,
                ticker: ticker(for: symbol),
                price: price,
                bias: r.tf1.bias,
                // Only crypto carries a 24h change (CoinGecko enrichment); the widget treats it as
                // optional, so stocks simply omit it rather than showing a fabricated 0%.
                change24h: r.sentiment?.priceChangePercentage24h,
                timestamp: r.timestamp
            )
        }
        .prefix(6)
        .map { $0 }

        guard let encoded = try? JSONEncoder().encode(assets) else { return }
        // Skip the write (and the widget reload) when the payload is byte-identical — WidgetKit
        // budgets timeline reloads, so spending one on unchanged data is actively wasteful.
        if let existing = defaults.data(forKey: dataKey), existing == encoded { return }
        defaults.set(encoded, forKey: dataKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "MarketScopeWidget")
    }

    /// "BTCUSDT" → "BTC"; stock symbols pass through unchanged.
    private static func ticker(for symbol: String) -> String {
        symbol.hasSuffix("USDT") ? String(symbol.dropLast(4)) : symbol
    }
}
