import SwiftUI

struct PositionCalculatorView: View {
    @State private var accountSize = ""
    @State private var riskPercent = "1.0"
    @State private var entryPrice = ""
    @State private var stopLoss = ""
    @State private var takeProfit = ""

    private var calculation: PositionCalc? {
        guard let account = Double(accountSize), account > 0,
              let risk = Double(riskPercent), risk > 0,
              let entry = Double(entryPrice), entry > 0,
              let sl = Double(stopLoss), sl > 0,
              entry != sl
        else { return nil }

        let dollarRisk = account * (risk / 100.0)
        let slDistance = abs(entry - sl)
        let positionSize = dollarRisk / slDistance
        let positionUSD = positionSize * entry
        let tp = Double(takeProfit)
        let rr: Double? = tp.map { abs($0 - entry) / slDistance }

        return PositionCalc(
            dollarRisk: dollarRisk,
            positionSize: positionSize,
            positionUSD: positionUSD,
            slDistance: slDistance,
            rr: rr
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    HStack {
                        Text("Size ($)")
                        TextField("10000", text: $accountSize)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Risk %")
                        TextField("1.0", text: $riskPercent)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("Trade") {
                    HStack {
                        Text("Entry Price")
                        TextField("0.00", text: $entryPrice)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Stop Loss")
                        TextField("0.00", text: $stopLoss)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Take Profit")
                        TextField("Optional", text: $takeProfit)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                }

                if let calc = calculation {
                    Section("Result") {
                        resultRow("Dollar Risk", value: Formatters.formatPrice(calc.dollarRisk))
                        resultRow("Position Size", value: Formatters.formatNumber(calc.positionSize, decimals: 6))
                        resultRow("Position USD", value: Formatters.formatPrice(calc.positionUSD))
                        resultRow("SL Distance", value: Formatters.formatPrice(calc.slDistance))
                        if let rr = calc.rr {
                            resultRow("Risk:Reward", value: String(format: "1:%.2f", rr))
                        }
                    }
                }
            }
            .navigationTitle("Position Calculator")
        }
    }

    private func resultRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .fontWeight(.semibold)
                .font(.system(.body, design: .monospaced))
        }
    }
}

private struct PositionCalc {
    let dollarRisk: Double
    let positionSize: Double
    let positionUSD: Double
    let slDistance: Double
    let rr: Double?
}
