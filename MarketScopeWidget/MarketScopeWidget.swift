import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

struct WidgetAssetEntry: TimelineEntry {
    let date: Date
    let assets: [WidgetAssetData]
}

struct WidgetAssetData: Identifiable {
    let id: String  // symbol
    let ticker: String
    let price: Double
    let bias: String
    let change24h: Double?
}

// MARK: - Timeline Provider

struct MarketScopeProvider: TimelineProvider {
    func placeholder(in context: Context) -> WidgetAssetEntry {
        WidgetAssetEntry(date: Date(), assets: [
            WidgetAssetData(id: "BTC", ticker: "BTC", price: 87500, bias: "Bullish", change24h: 2.1),
            WidgetAssetData(id: "ETH", ticker: "ETH", price: 2050, bias: "Neutral", change24h: -0.5),
        ])
    }

    func getSnapshot(in context: Context, completion: @escaping (WidgetAssetEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WidgetAssetEntry>) -> Void) {
        let assets = readSharedData()
        let entry = WidgetAssetEntry(date: Date(), assets: assets)
        let nextUpdate = Date().addingTimeInterval(15 * 60) // 15 min
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }

    private func readSharedData() -> [WidgetAssetData] {
        guard let defaults = UserDefaults(suiteName: "group.com.ludikure.CryptoLens"),
              let data = defaults.data(forKey: "widget_data"),
              let decoded = try? JSONDecoder().decode([SharedAsset].self, from: data)
        else { return [] }

        return decoded.map {
            WidgetAssetData(id: $0.symbol, ticker: $0.ticker, price: $0.price, bias: $0.bias, change24h: $0.change24h)
        }
    }

    private struct SharedAsset: Codable {
        let symbol: String
        let ticker: String
        let price: Double
        let bias: String
        let change24h: Double?
        let timestamp: Date
    }
}

// MARK: - Widget Views

struct SmallWidgetView: View {
    let entry: WidgetAssetEntry

    private var asset: WidgetAssetData? { entry.assets.first }

    var body: some View {
        if let asset {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(asset.ticker)
                        .font(.headline)
                        .fontWeight(.bold)
                    Spacer()
                    biasPill(asset.bias)
                }

                Text(formatPrice(asset.price))
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .monospacedDigit()

                Spacer()

                if let change = asset.change24h {
                    Text(String(format: "%+.2f%%", change))
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
            }
            .padding()
        } else {
            Text("No data")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct MediumWidgetView: View {
    let entry: WidgetAssetEntry

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        if entry.assets.isEmpty {
            Text("No favorites")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(entry.assets.prefix(4)) { asset in
                    HStack(spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(asset.ticker)
                                .font(.caption)
                                .fontWeight(.bold)
                            Text(formatPrice(asset.price))
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            biasPill(asset.bias)
                            if let change = asset.change24h {
                                Text(String(format: "%+.1f%%", change))
                                    .font(.system(size: 10))
                                    .foregroundStyle(change >= 0 ? .green : .red)
                            }
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                }
            }
            .padding(8)
        }
    }
}

// MARK: - Shared Helpers

private func biasPill(_ bias: String) -> some View {
    let color: Color = bias.contains("Bullish") ? .green : (bias.contains("Bearish") ? .red : .gray)
    let short: String
    switch bias {
    case "Strong Bullish": short = "Bull"
    case "Bullish": short = "Bull"
    case "Strong Bearish": short = "Bear"
    case "Bearish": short = "Bear"
    default: short = "Flat"
    }
    return Text(short)
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(color)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(color.opacity(0.15), in: Capsule())
}

private func formatPrice(_ price: Double) -> String {
    if price >= 1 {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return "$" + (formatter.string(from: NSNumber(value: price)) ?? String(format: "%.2f", price))
    } else if price >= 0.01 {
        return String(format: "$%.4f", price)
    } else {
        return String(format: "$%.6f", price)
    }
}

// MARK: - Widget Definition

struct MarketScopeWidget: Widget {
    let kind = "MarketScopeWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MarketScopeProvider()) { entry in
            Group {
                if #available(iOSApplicationExtension 17.0, *) {
                    WidgetContentView(entry: entry)
                        .containerBackground(.fill.tertiary, for: .widget)
                } else {
                    WidgetContentView(entry: entry)
                        .padding()
                        .background()
                }
            }
        }
        .configurationDisplayName("MarketScope")
        .description("Track your favorite assets at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct WidgetContentView: View {
    @Environment(\.widgetFamily) var family
    let entry: WidgetAssetEntry

    var body: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView(entry: entry)
        case .systemMedium:
            MediumWidgetView(entry: entry)
        default:
            SmallWidgetView(entry: entry)
        }
    }
}

@main
struct MarketScopeWidgetBundle: WidgetBundle {
    var body: some Widget {
        MarketScopeWidget()
    }
}
