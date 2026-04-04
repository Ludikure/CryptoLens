import SwiftUI

struct MacroContextView: View {
    let macro: MacroSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Macro", systemImage: "globe")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                if let regime = macro.macroRegime {
                    Text(regime)
                        .font(.caption2)
                        .fontWeight(.bold)
                        .foregroundStyle(regimeColor(regime))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(regimeColor(regime).opacity(0.12), in: Capsule())
                }
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                if let vix = macro.vix {
                    metricCell(
                        label: "VIX EOD",
                        value: String(format: "%.1f", vix),
                        color: vix > 30 ? .red : (vix > 20 ? .orange : .green),
                        note: vix > 35 ? "Crisis" : (vix > 25 ? "Elevated" : (vix < 15 ? "Low" : "Normal")),
                        tooltip: "VIX end-of-day close from FRED. S&P 500 fear gauge. <15 = complacent (watch for pullback). 15-25 = normal. 25-35 = elevated fear (reduce size). >35 = crisis (no new longs, defensive only)."
                    )
                }
                if let t10 = macro.treasury10Y {
                    metricCell(label: "10Y Yield", value: String(format: "%.2f%%", t10), color: .primary, note: nil,
                        tooltip: "10-Year Treasury yield. Rising = growth stocks pressured, financials benefit. Falling = growth stocks benefit. Benchmark for mortgage rates and corporate borrowing costs.")
                }
                if let t2 = macro.treasury2Y {
                    metricCell(label: "2Y Yield", value: String(format: "%.2f%%", t2), color: .primary, note: nil,
                        tooltip: "2-Year Treasury yield. Reflects near-term rate expectations. Tracks Fed policy more closely than 10Y. Rising = market expects higher rates.")
                }
                if let spread = macro.yieldSpread {
                    metricCell(
                        label: "2Y/10Y Spread",
                        value: String(format: "%.2f%%", spread),
                        color: spread < 0 ? .red : .green,
                        note: spread < 0 ? "Inverted" : "Normal",
                        tooltip: "Yield curve: 10Y minus 2Y. Positive (normal) = healthy economy. Negative (inverted) = recession signal — has preceded every US recession since 1970. Steepening after inversion = recession imminent."
                    )
                }
                if let fed = macro.fedFundsRate {
                    metricCell(label: "Fed Funds", value: String(format: "%.2f%%", fed), color: .primary, note: nil,
                        tooltip: "Federal Reserve target rate. Higher = restrictive policy (bearish for growth stocks, bullish for banks). Lower = accommodative (bullish for equities). Changes ~8 times per year at FOMC meetings.")
                }
                if let usd = macro.usdIndex {
                    metricCell(label: "DXY", value: String(format: "%.2f", usd), color: .primary, note: nil,
                        tooltip: "US Dollar Index (DXY) — ICE futures index tracking USD against 6 major currencies. Dollar up = headwind for equities and commodities. Dollar down = tailwind. Strong inverse correlation with stocks and crypto.")
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func metricCell(label: String, value: String, color: Color, note: String?, tooltip: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 3) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let tip = tooltip {
                    InfoTooltip(title: label, explanation: tip)
                }
            }
            HStack(spacing: 4) {
                Text(value)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(color)
                    .monospacedDigit()
                if let note {
                    Text(note)
                        .font(.system(size: 9))
                        .foregroundStyle(color)
                }
            }
        }
    }

    private func regimeColor(_ regime: String) -> Color {
        switch regime {
        case "Crisis": return .red
        case "Elevated Fear": return .orange
        case "Cautious": return .yellow
        case "Risk-On": return .green
        default: return .secondary
        }
    }
}
