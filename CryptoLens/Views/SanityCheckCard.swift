import SwiftUI

/// F-3 — Pre-trade "sanity check". A 3-question gut check shown alongside a trade setup,
/// derived entirely from the loaded analysis (no extra network call). It forces a 5-second pause
/// at exactly the moment a junior trader is most likely to act impulsively, naming the three
/// traps the target persona falls into: chasing an extended move, putting the stop inside the
/// noise zone, and trading into a high-impact event.
struct SanityCheckCard: View {
    let result: AnalysisResult

    var body: some View {
        if let check = SanityCheck.evaluate(result: result) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Gut check before you act", systemImage: "hand.raised.fill")
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                ForEach(check.items) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: item.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(item.ok ? .green : .orange)
                            .font(.caption)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.question).font(.caption).fontWeight(.medium)
                            Text(item.answer).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// Pure logic for the pre-trade gut check. Returns nil when there is no setup to check.
struct SanityCheck {
    struct Item: Identifiable {
        let id = UUID()
        let question: String
        let answer: String
        let ok: Bool          // true = clear / lower-risk; false = a flag to slow down on
    }
    let items: [Item]

    static func evaluate(result: AnalysisResult) -> SanityCheck? {
        guard let setup = result.tradeSetups.first else { return nil }
        let price = result.daily.price
        let isLong = setup.direction == "LONG"
        var items: [Item] = []

        // 1) Chasing vs pullback — entering in the breakout direction (above price for a long /
        // below price for a short) means buying/selling an extended move.
        let chasing = (isLong && setup.entry > price) || (!isLong && setup.entry < price)
        items.append(Item(
            question: "Pullback entry, or chasing a move that already ran?",
            answer: chasing
                ? "CHASING — entry is in the breakout direction. Entering an extended move is the most common way to buy the top / sell the bottom. Prefer a pullback to the entry."
                : "PULLBACK — the plan waits for price to come back to your entry. Lower-risk than chasing.",
            ok: !chasing))

        // 2) Stop inside or outside the noise zone — a stop closer than ~1×ATR(4H) is inside
        // normal noise and is likely to get wicked out before the idea has a chance.
        if let atr = result.tf2.atr?.atr, atr > 0, setup.risk > 0 {
            let stopATR = setup.risk / atr
            let inside = stopATR < 1.0
            items.append(Item(
                question: "Is your stop outside the noise zone?",
                answer: String(format: inside
                    ? "TIGHT — your stop is %.1f×ATR away; normal 4H noise can wick you out before the idea plays out."
                    : "OK — your stop is %.1f×ATR away, outside typical 4H noise.", stopATR),
                ok: !inside))
        }

        // 3) Major event within the window — high-impact release in the next 6 hours.
        let window: TimeInterval = 6 * 3600
        var soon: [EconomicEvent] = []
        for e in result.economicEvents {
            if e.isUpcoming && e.isHighImpact && e.date.timeIntervalSinceNow < window {
                soon.append(e)
            }
        }
        soon.sort { $0.date < $1.date }
        if let ev = soon.first {
            let mins = max(0, Int(ev.date.timeIntervalSinceNow / 60))
            let when = mins >= 60 ? "in \(mins / 60)h \(mins % 60)m" : "in \(mins)m"
            items.append(Item(
                question: "Any major event in the next few hours?",
                answer: "YES — \(ev.title) (\(ev.country)) \(when). High-impact events spike volatility; consider waiting it out or sizing down.",
                ok: false))
        } else {
            items.append(Item(
                question: "Any major event in the next few hours?",
                answer: "Clear — no high-impact event scheduled in the next 6 hours.",
                ok: true))
        }

        return SanityCheck(items: items)
    }
}
