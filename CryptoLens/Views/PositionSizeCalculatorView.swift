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
    // Risk-plan inputs are LOCAL scratch state seeded from the saved plan — a "what if I risked
    // 5%?" experiment must NOT silently rewrite the plan that Settings, the setup card, AND the
    // server prompt sizing all consume. "Save as my default" commits it explicitly. (2026-07-02)
    @State private var accountSize: Double
    @State private var riskPercent: Double
    @State private var maxLeverage: Double
    @State private var savedConfirmation = false
    @Environment(\.dismiss) private var dismiss

    init(symbol: String, entry: Double, stop: Double, direction: String) {
        self.symbol = symbol
        self.direction = direction
        _entry = State(initialValue: entry)
        _stop = State(initialValue: stop)
        let d = UserDefaults.standard
        _accountSize = State(initialValue: d.object(forKey: "accountSize") as? Double ?? 25000)
        _riskPercent = State(initialValue: d.object(forKey: "riskPercent") as? Double ?? 2.0)
        _maxLeverage = State(initialValue: d.object(forKey: "max_leverage") as? Double ?? 3.0)
    }

    private var sizing: PositionSizing? {
        PositionSizer.compute(accountSize: accountSize, riskPercent: riskPercent,
                              entry: entry, stop: stop, symbol: symbol, leverageCap: maxLeverage)
    }

    private var differsFromSaved: Bool {
        let d = UserDefaults.standard
        return accountSize != (d.object(forKey: "accountSize") as? Double ?? 25000)
            || riskPercent != (d.object(forKey: "riskPercent") as? Double ?? 2.0)
            || maxLeverage != (d.object(forKey: "max_leverage") as? Double ?? 3.0)
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
                    if differsFromSaved {
                        Button {
                            let d = UserDefaults.standard
                            d.set(accountSize, forKey: "accountSize")
                            d.set(riskPercent, forKey: "riskPercent")
                            d.set(maxLeverage, forKey: "max_leverage")
                            savedConfirmation = true
                        } label: {
                            Label(savedConfirmation ? "Saved" : "Save as my default", systemImage: savedConfirmation ? "checkmark" : "square.and.arrow.down")
                        }
                        .disabled(savedConfirmation)
                    }
                    if differsFromSaved && !savedConfirmation {
                        Text("These values are a what-if — your saved plan is unchanged unless you save.")
                            .font(.caption2).foregroundStyle(.secondary)
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
            .onChange(of: accountSize) { savedConfirmation = false }
            .onChange(of: riskPercent) { savedConfirmation = false }
            .onChange(of: maxLeverage) { savedConfirmation = false }
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
