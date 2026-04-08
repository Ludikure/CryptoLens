import SwiftUI

struct IndicatorTableView: View {
    let results: [IndicatorResult]
    var putCallRatio: Double? = nil
    var spotPressure: SpotPressure? = nil
    @State private var expanded = false

    private var hasStockIndicators: Bool {
        results.contains { $0.obv != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Collapsed header — always visible
            Button {
                withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text("Indicators")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)

                    Spacer()

                    // Compact bias summary when collapsed
                    if !expanded {
                        HStack(spacing: 4) {
                            ForEach(results) { r in
                                Text(r.label.replacingOccurrences(of: " (Trend)", with: "").replacingOccurrences(of: " (Bias)", with: "").replacingOccurrences(of: " (Entry)", with: ""))
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(biasColorSimple(r.bias))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(biasColorSimple(r.bias).opacity(0.12), in: Capsule())
                            }
                        }
                    }

                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 4)
            }
            .buttonStyle(.plain)

            if expanded {
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
                row("Bias Score", tooltip: "Signed score from all indicators combined. ±7+ = high conviction (backtest-proven). ±5-6 = tradeable with confluence. Below ±5 = no trade.") { r in
                    let score = r.biasScore
                    let color: Color = abs(score) >= 7 ? (score > 0 ? .green : .red) :
                                       abs(score) >= 5 ? (score > 0 ? Color.green.opacity(0.7) : Color.red.opacity(0.7)) :
                                       .secondary
                    Text("\(score > 0 ? "+" : "")\(score)")
                        .fontWeight(abs(score) >= 7 ? .bold : .regular)
                        .foregroundStyle(color)
                }
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
                row("MA Struct", tooltip: "EMA 20/50/200 alignment. Bullish = 20 > 50 > 200 (trend up). Bearish = 20 < 50 < 200 (trend down). Mixed = no clear stacking — trend in transition.") { r in
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
                    row("OBV", tooltip: "On Balance Volume — tracks cumulative volume flow. Rising = buying pressure. Falling = selling. Divergence from price = reversal warning.") { r in
                        if let obv = r.obv {
                            Text(obv.trend)
                                .foregroundStyle(obv.trend == "Rising" ? .green : (obv.trend == "Falling" ? .red : .secondary))
                        } else { dash }
                    }
                    row("A/D Line", tooltip: "Accumulation/Distribution — measures money flow based on where price closes within its range. Accumulation = smart money buying. Distribution = selling.") { r in
                        if let ad = r.adLine {
                            Text(ad.trend)
                                .foregroundStyle(ad.trend == "Accumulation" ? .green : .red)
                        } else { dash }
                    }
                    row("SMA Cross", tooltip: "50-day vs 200-day SMA. Golden Cross (50 crosses above 200) = bullish long-term signal. Death Cross (50 below 200) = bearish. Lagging indicator — confirms trend.") { r in
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
                    row("Liquidity", tooltip: "Average Daily Dollar Volume — how easily you can enter/exit. Very High = tight spreads. Low = slippage risk, wider stops needed.", isLast: true) { r in
                        if let addv = r.addv {
                            Text(addv.liquidity)
                                .foregroundStyle(addv.liquidity == "Very Low" || addv.liquidity == "Low" ? .orange : .secondary)
                        } else { dash }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.systemGray4), lineWidth: 0.5))
            .padding(.top, 8)

            // Single-value indicators (not per-timeframe)
            if putCallRatio != nil || spotPressure != nil {
                VStack(spacing: 0) {
                    if let pcr = putCallRatio {
                        singleRow("Put/Call", value: String(format: "%.2f", pcr),
                                  color: pcr > 1.0 ? .red : (pcr < 0.7 ? .orange : .primary),
                                  note: pcr > 1.0 ? "Bearish" : (pcr < 0.7 ? "Complacent" : "Neutral"),
                                  tooltip: "Put/call options ratio. >1.0 = bearish sentiment (contrarian buy). <0.7 = complacent (potential top).")
                    }
                    if let sp = spotPressure {
                        singleRow("Taker Buy", value: String(format: "%.0f%%", sp.takerBuyRatio * 100),
                                  color: sp.takerBuyRatio > 0.55 ? .green : (sp.takerBuyRatio < 0.45 ? .red : .primary),
                                  note: sp.takerBuyLabel,
                                  tooltip: "Who crosses the spread. >55% = aggressive buying. <45% = aggressive selling.")
                        singleRow("CVD 24h", value: String(format: "%.0f", sp.cvd24h),
                                  color: sp.cvdTrend == "Rising" ? .green : (sp.cvdTrend == "Falling" ? .red : .primary),
                                  note: sp.cvdTrend,
                                  tooltip: "Cumulative Volume Delta. Rising + price falling = accumulation. Falling + price rising = distribution (hollow rally).")
                        if let br = sp.bookRatio, let bl = sp.bookLabel {
                            singleRow("Order Book", value: String(format: "%.0f%% bids", br * 100),
                                      color: br > 0.6 ? .green : (br < 0.4 ? .red : .primary),
                                      note: bl,
                                      tooltip: "Bid vs ask depth. >60% bids = strong support. <40% = heavy selling pressure. Can be spoofed.")
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.systemGray4), lineWidth: 0.5))
                .padding(.top, 6)
            }
            } // if expanded
        }
        .font(.caption)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func singleRow(_ label: String, value: String, color: Color, note: String, tooltip: String) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 3) {
                Text(label).foregroundStyle(.secondary)
                InfoTooltip(title: label, explanation: tooltip)
            }
            .frame(width: 76, alignment: .leading)
            Text(value)
                .fontWeight(.medium)
                .foregroundStyle(color)
            Spacer()
            Text(note)
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
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
