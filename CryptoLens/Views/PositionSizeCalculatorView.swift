import SwiftUI

/// Live position-size calculator. Opened from a setup's PositionSizeCard (prefilled with its
/// entry/stop) or usable stand-alone. Lets the user override entry/stop/risk when they take a
/// different fill than the suggested one, and see the exact quantity, dollar risk, and leverage
/// update in real time. All inputs bind to the same AppStorage the rest of the app reads, so a
/// tweak here persists as the user's plan.
struct PositionSizeCalculatorView: View {
    let symbol: String
    let direction: String
    @State private var entry: Double
    @State private var stop: Double

    @AppStorage("accountSize") private var accountSize: Double = 25000
    @AppStorage("riskPercent") private var riskPercent: Double = 2.0
    @AppStorage("max_leverage") private var maxLeverage: Double = 3.0
    @Environment(\.dismiss) private var dismiss

    init(symbol: String, entry: Double, stop: Double, direction: String) {
        self.symbol = symbol
        self.direction = direction
        _entry = State(initialValue: entry)
        _stop = State(initialValue: stop)
    }

    private var sizing: PositionSizing? {
        PositionSizer.compute(accountSize: accountSize, riskPercent: riskPercent,
                              entry: entry, stop: stop, symbol: symbol, leverageCap: maxLeverage)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Your risk plan") {
                    HStack {
                        Text("Account size")
                        Spacer()
                        TextField("$", value: $accountSize, format: .currency(code: "USD"))
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Risk per trade")
                        Spacer()
                        TextField("%", value: $riskPercent, format: .number)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                            .frame(width: 70)
                        Text("%").foregroundStyle(.secondary)
                    }
                    Stepper(value: $maxLeverage, in: 1...20, step: 0.5) {
                        Text("Max leverage \(String(format: "%.1f", maxLeverage))×")
                    }
                }

                Section("This trade — \(symbol) \(direction.uppercased())") {
                    HStack {
                        Text("Entry")
                        Spacer()
                        TextField("entry", value: $entry, format: .number)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Stop")
                        Spacer()
                        TextField("stop", value: $stop, format: .number)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                }

                Section("Size") {
                    if let s = sizing {
                        row("Quantity", "\(PositionSizer.formatQuantity(s.quantity)) \(s.unitLabel)", bold: true)
                        row("Dollars at risk", Formatters.formatPrice(s.riskDollars))
                        row("Stop distance", String(format: "%.2f%%", s.stopDistancePercent))
                        row("Notional", Formatters.formatPrice(s.notional))
                        row("Leverage", String(format: "%.2f×", s.leverage),
                            tint: s.exceedsLeverageCap ? .orange : nil)
                        if s.exceedsLeverageCap {
                            Text("\(String(format: "%.1f", s.leverage))× exceeds your \(String(format: "%.1f", maxLeverage))× cap.")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    } else {
                        Text("Enter a valid entry and stop (they must differ).")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Position Size")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func row(_ label: String, _ value: String, bold: Bool = false, tint: Color? = nil) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .fontWeight(bold ? .bold : .regular)
                .foregroundStyle(tint ?? .primary)
        }
    }
}
