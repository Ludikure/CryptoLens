import Foundation

enum Formatters {
    private static let priceFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    static func formatPrice(_ price: Double) -> String {
        if price >= 1 {
            return "$" + (priceFormatter.string(from: NSNumber(value: price)) ?? String(format: "%.2f", price))
        } else if price >= 0.01 {
            return String(format: "$%.4f", price)
        } else {
            return String(format: "$%.6f", price)
        }
    }

    static func formatPercent(_ value: Double) -> String {
        String(format: "%+.2f%%", value)
    }

    static func formatVolume(_ volume: Double) -> String {
        if volume >= 1_000_000_000 {
            return String(format: "$%.1fB", volume / 1_000_000_000)
        } else if volume >= 1_000_000 {
            return String(format: "$%.1fM", volume / 1_000_000)
        } else if volume >= 1_000 {
            return String(format: "$%.1fK", volume / 1_000)
        }
        return String(format: "$%.0f", volume)
    }

    static func formatNumber(_ value: Double, decimals: Int = 2) -> String {
        String(format: "%.\(decimals)f", value)
    }
}
