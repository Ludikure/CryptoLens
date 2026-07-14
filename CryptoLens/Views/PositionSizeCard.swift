import SwiftUI

/// Feature #2 — a first-class position-size read on every trade setup. Sizing is the single biggest
/// determinant of whether a retail account survives, and it used to be buried inside the prompt text.
/// This surfaces the EXACT risk-based quantity (computed locally from the setup's entry/stop + the
/// user's account/risk settings), the dollars at risk, the notional, and the implied leverage — with
/// a loud warning when leverage exceeds the user's cap. "Adjust" opens a live calculator for when
/// you take a different fill than the suggested entry.
struct PositionSizeCard: View {
    let symbol: String
    let setup: TradeSetup

    @AppStorage("accountSize") private var accountSize: Double = 28000
    @AppStorage("riskPercent") private var riskPercent: Double = 2.0
    @AppStorage("max_leverage") private var maxLeverage: Double = 3.5
    @State private var showCalculator = false

    var body: some View {
        if let s = PositionSizer.compute(accountSize: accountSize, riskPercent: riskPercent,
                                         entry: setup.entry, stop: setup.stopLoss,
                                         symbol: symbol, leverageCap: maxLeverage) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("Position size", systemImage: "scalemass")
                        .font(.subheadline).fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Adjust") { showCalculator = true }
                        .font(.caption)
                }

                if let n = s.contracts, let spec = s.contractSpec {
                    Text("\(PositionSizer.formatContracts(n)) contract\(n == 1 ? "" : "s")")
                        .font(.title3).fontWeight(.bold)
                        .foregroundStyle(setup.direction.uppercased() == "SHORT" ? .red : .green)
                    Text("\(spec.label) · \(units(spec.unitsPerContract)) \(s.unitLabel)/contract = \(PositionSizer.formatQuantity(s.quantity)) \(s.unitLabel)")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("\(PositionSizer.formatQuantity(s.quantity)) \(s.unitLabel)")
                        .font(.title3).fontWeight(.bold)
                        .foregroundStyle(setup.direction.uppercased() == "SHORT" ? .red : .green)
                }

                Text("Risking \(money(s.riskDollars)) — \(pct(riskPercent)) of \(money(accountSize)) · stop \(String(format: "%.2f", s.stopDistancePercent))% away")
                    .font(.caption).foregroundStyle(.secondary)

                HStack(spacing: 4) {
                    Image(systemName: s.exceedsLeverageCap ? "exclamationmark.triangle.fill" : "creditcard")
                        .font(.caption2)
                        .foregroundStyle(s.exceedsLeverageCap ? .orange : .secondary)
                    Text("Notional \(money(s.notional)) · \(String(format: "%.2f", s.leverage))× account")
                        .font(.caption)
                        .foregroundStyle(s.exceedsLeverageCap ? .orange : .secondary)
                }

                if s.exceedsLeverageCap {
                    Text("\(String(format: "%.1f", s.leverage))× exceeds your \(String(format: "%.1f", maxLeverage))× cap — size down, or wait for an entry closer to your stop.")
                        .font(.caption2).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .sheet(isPresented: $showCalculator) {
                PositionSizeCalculatorView(symbol: symbol, entry: setup.entry, stop: setup.stopLoss, direction: setup.direction)
            }
        }
    }

    private func money(_ v: Double) -> String { Formatters.formatPrice(v) }
    private func pct(_ v: Double) -> String { String(format: "%.1f%%", v) }
    /// 0.01 → "0.01", 0.1 → "0.1" (strip trailing zeros).
    private func units(_ v: Double) -> String {
        String(format: "%g", v)
    }
}
