import Foundation

/// Deterministic risk-based position sizing. This is the honest, transparent version of the number
/// the prompt hints at: given the user's account size + risk-per-trade and the setup's stop
/// distance, it computes the EXACT quantity that risks precisely that dollar amount if the stop is
/// hit. Computed client-side from the setup's entry/stop — never trusts the LLM's loose JSON qty.
///
/// qty = (accountSize × risk%) ÷ |entry − stop|   (risk-per-unit)
/// so if price travels from entry to the stop, the loss ≈ the intended risk budget.
///
/// For symbols traded as **futures contracts** (Coinbase nano BTC = 0.01 BTC, nano ETH = 0.1 ETH),
/// the ideal quantity is rounded to a WHOLE number of contracts — the number you actually punch
/// into the broker — and the risk/notional/leverage are recomputed from that rounded size, so the
/// figures shown are what you'll really carry, not a fractional-unit ideal you can't place.

/// A tradeable futures contract spec: how much underlying one contract represents.
struct ContractSpec {
    let label: String        // "nano BTC"
    let unitsPerContract: Double  // 0.01 BTC / 0.1 ETH
}

struct PositionSizing {
    let riskDollars: Double        // dollars at risk if the stop is hit (REALIZED, after any contract rounding)
    let quantity: Double           // units of underlying (coins / shares) — realized
    let notional: Double           // qty × entry — the position's face value
    let leverage: Double           // notional ÷ account (>1 means borrowing / margin)
    let stopDistancePercent: Double
    let unitLabel: String          // "BTC" / "shares"
    let leverageCap: Double
    let contractSpec: ContractSpec?  // nil for spot/share sizing
    let contracts: Int?              // whole contracts to trade (nil when contractSpec is nil)
    var exceedsLeverageCap: Bool { leverage > leverageCap }
}

enum PositionSizer {
    /// "BTC" from "BTCUSDT"; "shares" for stocks.
    static func unitLabel(for symbol: String) -> String {
        let s = symbol.uppercased()
        if s.hasSuffix("USDT") { return String(s.dropLast(4)) }
        return "shares"
    }

    /// Base asset ("BTC" from "BTCUSDT"/"BTC-PERP"/"BTC").
    private static func baseAsset(for symbol: String) -> String {
        var s = symbol.uppercased()
        for suffix in ["USDT", "-PERP", "PERP", "USD"] where s.hasSuffix(suffix) { s = String(s.dropLast(suffix.count)); break }
        return s.trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
    }

    /// The futures contract spec for a symbol, or nil if we size it in raw units (shares / spot).
    /// Coinbase Derivatives nano contracts: BTC = 0.01 BTC, ETH = 0.1 ETH.
    static func contractSpec(for symbol: String) -> ContractSpec? {
        switch baseAsset(for: symbol) {
        case "BTC": return ContractSpec(label: "nano BTC", unitsPerContract: 0.01)
        case "ETH": return ContractSpec(label: "nano ETH", unitsPerContract: 0.1)
        default:    return nil
        }
    }

    static func compute(accountSize: Double, riskPercent: Double, entry: Double, stop: Double,
                        symbol: String, leverageCap: Double) -> PositionSizing? {
        let riskPerUnit = abs(entry - stop)
        guard accountSize > 0, riskPercent > 0, entry > 0, riskPerUnit > 0 else { return nil }
        let riskBudget = accountSize * riskPercent / 100.0
        let idealQty = riskBudget / riskPerUnit

        // Round to whole contracts where a contract spec exists — that's the real tradeable size.
        let spec = contractSpec(for: symbol)
        let contracts: Int?
        let quantity: Double
        if let spec, spec.unitsPerContract > 0 {
            let whole = max(1, (idealQty / spec.unitsPerContract).rounded())  // nearest whole, ≥ 1
            contracts = Int(whole)
            quantity = whole * spec.unitsPerContract
        } else {
            contracts = nil
            quantity = idealQty
        }

        let notional = quantity * entry
        return PositionSizing(
            riskDollars: quantity * riskPerUnit,   // realized risk (≈ budget; exact when no rounding)
            quantity: quantity,
            notional: notional,
            leverage: notional / accountSize,
            stopDistancePercent: riskPerUnit / entry * 100.0,
            unitLabel: unitLabel(for: symbol),
            leverageCap: leverageCap,
            contractSpec: spec,
            contracts: contracts
        )
    }

    /// Whole-contract count with thousands separators for large counts.
    static func formatContracts(_ n: Int) -> String {
        let fmt = NumberFormatter(); fmt.numberStyle = .decimal; fmt.maximumFractionDigits = 0
        return fmt.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// Quantity with sensible precision (small crypto sizes need more decimals than share counts).
    /// Large counts get thousands separators — a raw "12345678 PEPE" is unreadable.
    static func formatQuantity(_ q: Double) -> String {
        if q >= 1000 {
            let fmt = NumberFormatter()
            fmt.numberStyle = .decimal
            fmt.maximumFractionDigits = 0
            return fmt.string(from: NSNumber(value: q)) ?? String(format: "%.0f", q)
        }
        if q >= 1 { return String(format: "%.2f", q) }
        if q >= 0.01 { return String(format: "%.4f", q) }
        return String(format: "%.6f", q)
    }
}
