import SwiftUI

/// Two taps at the moment you act. That is the whole design constraint: a journal that costs
/// more than that does not get kept, and an unkept journal attributes nothing.
///
/// `.take` records that you entered a proposal (fill prefilled with the proposed entry, contracts
/// prefilled from the position sizer). `.close` records how it ended. Everything else — linking
/// to the tracked row, grading, the comparison — happens on the box.
struct JournalEntrySheet: View {
    enum Mode {
        case take(symbol: String, direction: String, source: String,
                  proposedEntry: Double, proposedStop: Double, proposedTarget: Double?)
        case close(WorkerJournalService.Entry)
    }

    let mode: Mode
    var onDone: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @AppStorage("accountSize") private var accountSize: Double = 28000
    @AppStorage("riskPercent") private var riskPercent: Double = 2.0
    @AppStorage("max_leverage") private var maxLeverage: Double = 3.5

    @State private var fill: String = ""
    @State private var contracts: String = ""
    @State private var exit: String = ""
    @State private var reason: String = ""
    @State private var note: String = ""
    @State private var saving = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                switch mode {
                case .take(let symbol, let direction, _, let entry, let stop, _):
                    Section {
                        LabeledContent("Fill price") {
                            TextField(Formatters.formatPrice(entry), text: $fill)
                                .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                        LabeledContent(PositionSizer.contractSpec(for: symbol) != nil ? "Contracts" : "Quantity") {
                            TextField(suggestedSize(symbol: symbol, entry: entry, stop: stop), text: $contracts)
                                .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                    } header: {
                        Text("\(ticker(symbol)) \(direction)")
                    } footer: {
                        Text("Leave the fill blank to record the proposed entry. Stop \(Formatters.formatPrice(stop)) is kept from the proposal — it is what your R is measured against.")
                    }
                    Section("Note (optional)") {
                        TextField("Why you took it", text: $note, axis: .vertical).lineLimit(2...4)
                    }

                case .close(let e):
                    Section {
                        LabeledContent("Exit price") {
                            TextField("", text: $exit).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                        Picker("How it ended", selection: $reason) {
                            Text("Target").tag("target")
                            Text("Stopped").tag("stop")
                            Text("Took profit early").tag("early_profit")
                            Text("Cut early").tag("early_cut")
                            Text("Time").tag("time")
                        }
                        if let r = previewR(e) {
                            LabeledContent("Your result") {
                                Text(String(format: "%+.2fR", r)).font(Theme.mono)
                                    .foregroundStyle(r >= 0 ? Theme.bullish : Theme.bearish)
                            }
                        }
                    } header: {
                        Text("\(ticker(e.symbol)) \(e.direction) · filled \(Formatters.formatPrice(e.fillPrice))")
                    } footer: {
                        if e.proposedStop == nil {
                            Text("This entry has no stop on record, so a result in R cannot be computed for it.")
                        }
                    }
                    Section("Note (optional)") {
                        TextField("What you learned", text: $note, axis: .vertical).lineLimit(2...4)
                    }
                }

                if failed {
                    Section { Text("Couldn't save — check the connection and try again.").foregroundStyle(Theme.caution) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || !canSave)
                }
            }
            .onAppear {
                if case .close(let e) = mode, reason.isEmpty { reason = "target"; note = e.note ?? "" }
            }
        }
    }

    private var title: String {
        switch mode {
        case .take:  return "I took this"
        case .close: return "Close trade"
        }
    }

    private var canSave: Bool {
        switch mode {
        case .take:  return fill.isEmpty || Double(fill).map { $0 > 0 } == true
        case .close: return Double(exit).map { $0 > 0 } == true
        }
    }

    private func ticker(_ s: String) -> String { s.hasSuffix("USDT") ? String(s.dropLast(4)) : s }

    private func suggestedSize(symbol: String, entry: Double, stop: Double) -> String {
        guard let s = PositionSizer.compute(accountSize: accountSize, riskPercent: riskPercent,
                                            entry: entry, stop: stop, symbol: symbol, leverageCap: maxLeverage)
        else { return "" }
        if let c = s.contracts { return String(c) }
        return String(format: "%.4f", s.quantity)
    }

    private func previewR(_ e: WorkerJournalService.Entry) -> Double? {
        guard let x = Double(exit), let stop = e.proposedStop else { return nil }
        let risk = abs(e.fillPrice - stop)
        guard risk > 0 else { return nil }
        return e.direction == "LONG" ? (x - e.fillPrice) / risk : (e.fillPrice - x) / risk
    }

    private func save() async {
        saving = true; failed = false
        let ok: Bool
        switch mode {
        case .take(let symbol, let direction, let source, let entry, let stop, let target):
            let fillPrice = Double(fill) ?? entry
            let size = Double(contracts)
            let riskUsd: Double? = {
                guard let size else { return nil }
                let units = PositionSizer.contractSpec(for: symbol)?.unitsPerContract ?? 1
                return abs(fillPrice - stop) * size * units
            }()
            ok = await WorkerJournalService.create(.init(
                source: source, refId: nil, symbol: symbol, direction: direction,
                proposedEntry: entry, proposedStop: stop, proposedTarget: target,
                fillPrice: fillPrice, contracts: size, riskUsd: riskUsd,
                note: note.isEmpty ? nil : note))
        case .close(let e):
            ok = await WorkerJournalService.close(.init(
                id: e.id, exitPrice: Double(exit) ?? 0, exitReason: reason.isEmpty ? nil : reason,
                note: note.isEmpty ? nil : note))
        }
        saving = false
        if ok { HapticManager.impact(.light); onDone(); dismiss() } else { failed = true }
    }
}
