import SwiftUI

struct IndicatorTableView: View {
    let results: [IndicatorResult]

    private var hasStockIndicators: Bool {
        results.contains { $0.obv != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Indicators")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                // Header
                HStack(spacing: 0) {
                    Text("")
                        .frame(width: 76, alignment: .leading)
                    ForEach(results) { r in
                        Text(r.timeframe.uppercased())
                            .font(.caption)
                            .fontWeight(.bold)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 8)
                .background(Color(.systemGray5))

                // Rows
                row("RSI", tooltip: Tooltips.rsi) { r in
                    if let rsi = r.rsi {
                        Text(String(format: "%.1f", rsi))
                            .foregroundStyle(rsiColor(rsi))
                    } else { dash }
                }
                row("Stoch RSI", tooltip: Tooltips.stochRSI) { r in
                    if let s = r.stochRSI {
                        Text("\(Int(s.k))/\(Int(s.d))")
                            .foregroundStyle(rsiColor(s.k))
                    } else { dash }
                }
                row("MACD Hist", tooltip: Tooltips.macd) { r in
                    if let m = r.macd {
                        Text(String(format: "%.1f", m.histogram))
                            .foregroundStyle(m.histogram > 0 ? .green : .red)
                    } else { dash }
                }
                row("ADX", tooltip: Tooltips.adx) { r in
                    if let a = r.adx {
                        Text("\(Int(a.adx)) \(a.direction == "Bullish" ? "↑" : "↓")")
                            .foregroundStyle(a.direction == "Bullish" ? .green : .red)
                    } else { dash }
                }
                row("BB %B", tooltip: Tooltips.bollingerBands) { r in
                    if let bb = r.bollingerBands {
                        Text(String(format: "%.2f", bb.percentB))
                            .foregroundStyle(bb.percentB > 1 ? .red : (bb.percentB < 0 ? .green : .primary))
                    } else { dash }
                }
                row("Volume", tooltip: Tooltips.volume) { r in
                    if let vol = r.volumeRatio {
                        Text(String(format: "%.1fx", vol))
                            .foregroundStyle(vol > 2 ? .orange : .primary)
                    } else { dash }
                }
                row("MA Struct") { r in
                    if let e20 = r.ema20, let e50 = r.ema50, let e200 = r.ema200 {
                        if e20 > e50 && e50 > e200 {
                            Text("Bull").foregroundStyle(.green)
                        } else if e20 < e50 && e50 < e200 {
                            Text("Bear").foregroundStyle(.red)
                        } else {
                            Text("Mixed").foregroundStyle(.secondary)
                        }
                    } else { dash }
                }
                row("Divergence", tooltip: Tooltips.divergence, isLast: !hasStockIndicators) { r in
                    if let div = r.divergence {
                        Text(div.contains("bullish") ? "Bull ⚡" : "Bear ⚡")
                            .foregroundStyle(div.contains("bullish") ? .green : .red)
                    } else { Text("—").foregroundStyle(.quaternary) }
                }

                // Stock-only rows (shown only if data present)
                if hasStockIndicators {
                    row("OBV") { r in
                        if let obv = r.obv {
                            Text(obv.trend)
                                .foregroundStyle(obv.trend == "Rising" ? .green : (obv.trend == "Falling" ? .red : .secondary))
                        } else { dash }
                    }
                    row("A/D Line") { r in
                        if let ad = r.adLine {
                            Text(ad.trend)
                                .foregroundStyle(ad.trend == "Accumulation" ? .green : .red)
                        } else { dash }
                    }
                    row("SMA Cross") { r in
                        if let cross = r.smaCross {
                            if let recent = cross.recentCross {
                                Text(recent.contains("Golden") ? "Golden ✦" : "Death ✦")
                                    .foregroundStyle(recent.contains("Golden") ? .green : .red)
                            } else {
                                Text(cross.sma50 > cross.sma200 ? "50>200" : "50<200")
                                    .foregroundStyle(cross.sma50 > cross.sma200 ? .green : .red)
                            }
                        } else { dash }
                    }
                    row("Liquidity", isLast: true) { r in
                        if let addv = r.addv {
                            Text(addv.liquidity)
                                .foregroundStyle(addv.liquidity == "Very Low" || addv.liquidity == "Low" ? .orange : .secondary)
                        } else { dash }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.systemGray4), lineWidth: 0.5))
        }
        .font(.caption)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private var dash: some View {
        Text("—").foregroundStyle(.quaternary)
    }

    private func rsiColor(_ val: Double) -> Color {
        if val > 70 { return .red }
        if val < 30 { return .green }
        return .primary
    }

    @ViewBuilder
    private func row(_ label: String, tooltip: String? = nil, isLast: Bool = false, @ViewBuilder value: @escaping (IndicatorResult) -> some View) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 3) {
                Text(label)
                    .foregroundStyle(.secondary)
                if let tip = tooltip {
                    InfoTooltip(title: label, explanation: tip)
                }
            }
            .frame(width: 76, alignment: .leading)
            ForEach(results) { r in
                value(r)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
        if !isLast {
            Divider().padding(.leading, 8)
        }
    }
}
