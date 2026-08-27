import SwiftUI

/// The trade card — the second half of Phase 1, and the direct implementation of the corrected
/// spec's §15.
///
/// **§15 deleted the weighted 0-100 opportunity score.** Its weights were invented and its
/// components measure zero: breakdown-SHORT came back −0.0379 and vol-expansion-SHORT −0.0355, both
/// CIs clear of zero on the WRONG side, and the rest span it. A composite over components like that
/// launders judgment as measurement — which is the exact thing §34 forbids, implemented in §15.
///
/// So this card is a CHECKLIST: every component is shown, and **nothing is summed.** The one number
/// it ranks on, net expected R, is shown as itself in R units rather than rescaled into a score.
///
/// It is also where the row's five numbers become fifteen. The scanner row deliberately hides win
/// probability, the gross edge, the fee and the branch percentages; this is the "one tap away" they
/// live at.
struct TradeCardView: View {
    let opportunity: WorkerOpportunitiesService.Opportunity
    let book: WorkerOpportunitiesService.Book?
    var onOpenSymbol: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss

    private var o: WorkerOpportunitiesService.Opportunity { opportunity }
    /// Sized-at risk, not the local default — see `OpportunitiesView.sizedRiskPercent`.
    private var sizedRiskPercent: Double? { book?.structure?.maxRiskPerTrade.map { $0 * 100 } }
    private var oneR: Double { OpportunityCopy.oneR(riskPercent: sizedRiskPercent) }
    private var mood: OpportunityCopy.Mood? { .from(book?.fearGreed) }
    private var ticker: String {
        o.asset.hasSuffix("USDT") ? String(o.asset.dropLast(4)) : o.asset
    }

    var body: some View {
        NavigationStack {
            List {
                Section { header }
                Section { levels }
                Section { checklist } header: { Text("The read, component by component") }
                    footer: { Text(checklistFooter) }
                Section { payoffShape } header: { Text("How this ends") }
                    footer: { Text(shapeFooter) }
                if let st = book?.structure { Section { structureRows(st) }
                    header: { Text("The structure") } footer: { Text(structureFooter) } }
                Section { sizing } header: { Text("Size") }
                if let caveat = book?.caveat {
                    Section { Text(caveat).font(Theme.caption).foregroundStyle(.secondary) }
                }
                Section {
                    Button("Open \(ticker)") { onOpenSymbol(o.asset) }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("\(ticker) \(o.direction)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(o.direction)
                    .themedPill(o.direction == "LONG" ? Theme.bullish : Theme.bearish)
                Spacer()
                Text(rText(o.expectedValueR))
                    .font(Theme.mono).fontWeight(.medium).foregroundStyle(Theme.info)
            }
            if let money = OpportunityCopy.money(forR: o.expectedValueR, riskPercent: sizedRiskPercent) {
                Text("Net expected value — \(money), averaged over many trades.")
                    .font(Theme.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Levels

    private var levels: some View {
        HStack(alignment: .top, spacing: 14) {
            // NO GREEN. The screen's colour law reserves it for money that already exists, on an
            // open position, and a target price is the opposite of that — it is the number most
            // likely never to be reached (7.9% of the time here). Entry carries the emphasis
            // instead, because it is the only number on this card you act on.
            level("Entry", o.entry, .primary)
            level("Stop", o.stop, Theme.bearish)
            level("Target", o.target, .secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("Stop is").font(Theme.micro).foregroundStyle(.tertiary)
                Text("\(String(format: "%.1f", o.stopDistancePercent))%").font(Theme.mono)
            }
        }
    }

    private func level(_ label: String, _ value: Double, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(Theme.micro).foregroundStyle(.tertiary)
            Text(Formatters.formatPrice(value)).font(Theme.mono).foregroundStyle(color)
        }
    }

    // MARK: - Checklist (§15)

    private var checklist: some View {
        VStack(spacing: 0) {
            check("Net expected R", rText(o.expectedValueR), Theme.info)
            if let gross = o.grossExpectedValueR {
                check("Gross expected R", rText(gross), .secondary)
            }
            if let fee = o.feeBurdenR {
                check("Fee burden", feeText(fee), feeColour(fee))
            }
            if let risk = drawdownText { check("Drawdown risk", risk.0, risk.1) }
            // The scanner only ever shows rows the Conviction Envelope did NOT auto-FLAT: the
            // endpoint runs the real precheck per symbol and drops the ones it stops. That is what
            // stops this screen and the AI read contradicting each other, as they did on 2026-08-25.
            // Not green either: the law keeps green for money that exists, and a gate that opened is
            // a precondition, not a result.
            //
            // And not "PASSED", which over-claimed in two ways the endpoint's own code states. The
            // precheck is wrapped in try/catch and returns null on a throw, which the caller reads
            // as "no reasons" and shows the row — so a D1 hiccup rendered as a gate that passed
            // rather than one that never ran. It also runs with `economicEvents: []` and no
            // enrichment, so macro and every enrichment-dependent kill condition structurally
            // cannot fire; the endpoint comments that it "can only UNDER-suppress".
            check("Analysis gate", "not auto-FLAT", .secondary)
            if let m = mood {
                check("Mood context", moodText(m), m.shortEdgeAbsent && o.direction == "SHORT"
                      ? Theme.caution : .secondary)
            }
            check("Regime status", OpportunityCopy.regimeStatus, Theme.caution)
        }
    }

    private var checklistFooter: String {
        "Shown, never summed. A single 0-100 score would need weights, and no component here has "
        + "measured expectancy to derive them from — so the only number this ranks on is net "
        + "expected R, in R. The analysis gate is a partial check: it runs without macro events or "
        + "enrichment, so it can only miss reasons to stand aside, never invent them."
    }

    private func check(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(Theme.caption).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).font(Theme.caption).foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 3)
    }

    private var drawdownText: (String, Color)? {
        guard let r = book?.crashReadings?.first(where: { $0.asset == o.asset }) else { return nil }
        let base = book?.crashModel?.baseRate
        let level = "\(pctWhole(r.probability))"
        guard let b = base else { return (level, .secondary) }
        let over = Int(((r.probability - b) * 100).rounded())
        let text = "\(level) — a normal day is \(pctWhole(b))"
        return (text, over >= 8 ? Theme.caution : .secondary)
    }

    private func moodText(_ m: OpportunityCopy.Mood) -> String {
        guard o.direction == "SHORT" else { return m.label }
        return m.shortEdgeAbsent
            ? "\(m.label) — short edge measured NEGATIVE here"
            : "\(m.label) — short expectancy favourable"
    }

    private func feeText(_ fee: Double) -> String {
        guard let gross = o.grossExpectedValueR, gross > 0 else { return rText(-fee) }
        return "\(rText(-fee)) — \(Int((fee / gross * 100).rounded()))% of the gross"
    }

    private func feeColour(_ fee: Double) -> Color {
        guard let gross = o.grossExpectedValueR, gross > 0 else { return .secondary }
        return fee / gross > 0.5 ? Theme.caution : .secondary
    }

    // MARK: - Payoff shape

    @ViewBuilder
    private var payoffShape: some View {
        if let b = o.branches {
            VStack(spacing: 0) {
                branch("Reaches target", b.target, o.payoffAsymmetry, .primary)
                branch("Stops out", b.stop, -1, Theme.bearish)
                branch("Runs out of time", b.timeout, b.timeoutPayR, .secondary)
            }
        } else {
            Text("Branch detail needs a newer backend than this one.")
                .font(Theme.caption).foregroundStyle(.secondary)
        }
    }

    private func branch(_ label: String, _ p: Double, _ payR: Double, _ color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(Theme.caption).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(pct(p)).font(Theme.mono).foregroundStyle(.primary)
                .frame(width: 52, alignment: .trailing)
            Text(rText(payR, decimals: 1)).font(Theme.mono).foregroundStyle(color)
                .frame(width: 56, alignment: .trailing)
            if oneR > 0 {
                Text(moneyText(payR * oneR)).font(Theme.mono).foregroundStyle(color)
                    .frame(width: 76, alignment: .trailing)
            }
        }
        .padding(.vertical, 3)
    }

    private var shapeFooter: String {
        var s = "This is why the average is not the typical outcome: most trades here lose one R. "
        if let hours = book?.structure?.holdingHorizonHours {
            s += "Held up to \(Int(hours)) hours. "
        }
        s += "A timeout exit is not zero — it pays what it was worth when the clock ran out."
        return s
    }

    // MARK: - Structure
    //
    // Named explicitly because it is NOT the structure the AI read proposes for the same symbol,
    // and the difference is not cosmetic: this stops at 1 ATR, the analysis stops at 4 on a long.
    // Taking this entry with that stop misprices the risk fourfold. §9 forbids reconciling them by
    // moving one lever, so the honest interim is to say which is which.

    private func structureRows(_ st: WorkerOpportunitiesService.Structure) -> some View {
        VStack(spacing: 0) {
            check("Stop", "\(fmt(st.stopAtrMultiple)) ATR", .secondary)
            check("Target", "\(fmt(st.targetR))R", .secondary)
            check("Held up to", "\(Int(st.holdingHorizonHours))h", .secondary)
            check("Round trip", "\(fmt(st.roundTripPercent))%", .secondary)
        }
    }

    private var structureFooter: String {
        "This is the only geometry the ranking model was measured at, so its expected R is valid "
        + "here and nowhere else. The AI read on this symbol sizes a DIFFERENT trade — 4 ATR stops "
        + "on a long, 2 on a short. Use one or the other, never one's entry with the other's stop."
    }

    // MARK: - Sizing

    private var sizing: some View {
        VStack(spacing: 0) {
            if o.positionUsd > 0 { check("Position", unsignedMoney(o.positionUsd), .primary) }
            check("Risk if stopped", "\(fmt(o.riskFraction * 100))% of the account", .secondary)
            if o.crashMultiplier < 1 {
                check("Drawdown cut", "sized to \(Int((o.crashMultiplier * 100).rounded()))%",
                      Theme.caution)
            }
            ForEach(OpportunityCopy.plainList(o.bindingConstraints), id: \.self) { c in
                check("Limit", c, Theme.caution)
            }
        }
    }

    // MARK: - Formatting

    private func rText(_ r: Double, decimals: Int = 3) -> String {
        String(format: "%+.\(decimals)fR", r)
    }
    private func pct(_ p: Double) -> String { String(format: "%.1f%%", p * 100) }
    private func pctWhole(_ p: Double) -> String { "\(Int((p * 100).rounded()))%" }
    private func fmt(_ v: Double) -> String { String(format: "%.2f", v) }
    /// A position size has no sign — rendering it "+$19,040" reads as a gain.
    private func unsignedMoney(_ dollars: Double) -> String {
        String(moneyText(dollars).dropFirst())
    }

    private func moneyText(_ dollars: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        let n = f.string(from: NSNumber(value: abs(dollars))) ?? "\(Int(abs(dollars)))"
        return "\(dollars < 0 ? "−" : "+")$\(n)"
    }
}
