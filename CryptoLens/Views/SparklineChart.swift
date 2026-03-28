import SwiftUI
import Charts

/// Compact 7-day price sparkline.
struct SparklineChart: View {
    let candles: [Candle]

    private var last7Days: [Candle] {
        Array(candles.suffix(7))
    }

    private var isUp: Bool {
        guard let first = last7Days.first, let last = last7Days.last else { return true }
        return last.close >= first.close
    }

    private var lineColor: Color { isUp ? .green : .red }

    var body: some View {
        if last7Days.count >= 2 {
            Chart {
                ForEach(Array(last7Days.enumerated()), id: \.offset) { idx, candle in
                    LineMark(
                        x: .value("Day", idx),
                        y: .value("Price", candle.close)
                    )
                    .foregroundStyle(lineColor)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Day", idx),
                        y: .value("Price", candle.close)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [lineColor.opacity(0.2), lineColor.opacity(0.0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: 50)
        }
    }
}
