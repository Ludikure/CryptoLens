import Foundation

/// Deterministic risk-based position sizing. This is the honest, transparent version of the number
/// the prompt hints at: given the user's account size + risk-per-trade and the setup's stop
/// distance, it computes the EXACT quantity that risks precisely that dollar amount if the stop is
/// hit. Computed client-side from the setup's entry/stop — never trusts the LLM's loose JSON qty.
///
/// qty = (accountSize × risk%) ÷ |entry − stop|   (risk-per-unit)
/// so if price travels from entry to the stop, the loss ≈ the intended risk budget.
struct PositionSizing {
    let riskDollars: Double        // dollars at risk if the stop is hit
    let quantity: Double           // units (coins / shares)
    let notional: Double           // qty × entry — the position's face value
    let leverage: Double           // notional ÷ account (>1 means borrowing / margin)
    let stopDistancePercent: Double
    let unitLabel: String          // "BTC" / "shares"
    let leverageCap: Double
    var exceedsLeverageCap: Bool { leverage > leverageCap }
}

enum PositionSizer {
    /// "BTC" from "BTCUSDT"; "shares" for stocks.
    static func unitLabel(for symbol: String) -> String {
        let s = symbol.uppercased()
        if s.hasSuffix("USDT") { return String(s.dropLast(4)) }
        return "shares"
    }

    static func compute(accountSize: Double, riskPercent: Double, entry: Double, stop: Double,
                        symbol: String, leverageCap: Double) -> PositionSizing? {
        let riskPerUnit = abs(entry - stop)
        guard accountSize > 0, riskPercent > 0, entry > 0, riskPerUnit > 0 else { return nil }
        let riskDollars = accountSize * riskPercent / 100.0
        let quantity = riskDollars / riskPerUnit
        let notional = quantity * entry
        return PositionSizing(
            riskDollars: riskDollars,
            quantity: quantity,
            notional: notional,
            leverage: notional / accountSize,
            stopDistancePercent: riskPerUnit / entry * 100.0,
            unitLabel: unitLabel(for: symbol),
            leverageCap: leverageCap
        )
    }

    /// Quantity with sensible precision (small crypto sizes need more decimals than share counts).
    static func formatQuantity(_ q: Double) -> String {
        if q >= 1000 { return String(format: "%.0f", q) }
        if q >= 1 { return String(format: "%.2f", q) }
        if q >= 0.01 { return String(format: "%.4f", q) }
        return String(format: "%.6f", q)
    }
}
