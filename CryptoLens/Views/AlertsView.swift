import SwiftUI

struct AlertsView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var coordinator: NavigationCoordinator
    @State private var showCreateAlert = false

    private var allSetups: [SetupGroup] {
        (groupedSetups(direction: "LONG") + groupedSetups(direction: "SHORT"))
            .sorted { ($0.alerts.first?.createdAt ?? .distantPast) > ($1.alerts.first?.createdAt ?? .distantPast) }
    }
    private var customAlerts: [PriceAlert] {
        alertsStore.alerts.filter { !$0.note.contains("LONG") && !$0.note.contains("SHORT") && !$0.triggered }
    }
    private var triggeredAlerts: [PriceAlert] { alertsStore.alerts.filter(\.triggered) }

    var body: some View {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(allSetups) { group in
                        SetupCard(group: group, direction: group.direction, onDismiss: {
                            withAnimation(.easeOut(duration: 0.25)) { removeGroup(group) }
                        }, onViewAnalysis: {
                            let symbol = group.alerts.first?.symbol ?? ""
                            if !symbol.isEmpty {
                                coordinator.navigateToAnalysis(symbol: symbol)
                            }
                        })
                    }

                    ForEach(customAlerts) { alert in
                        CustomAlertCard(alert: alert) {
                            withAnimation { alertsStore.removeAlert(id: alert.id) }
                        }
                    }

                    if !triggeredAlerts.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Triggered")
                                .font(.caption).foregroundStyle(.tertiary).padding(.horizontal)
                            ForEach(triggeredAlerts) { alert in
                                TriggeredRow(alert: alert) {
                                    withAnimation { alertsStore.removeAlert(id: alert.id) }
                                }
                            }
                        }
                        .padding(.horizontal)
                    }

                    if alertsStore.alerts.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "bell.slash")
                                .font(.system(size: 44)).foregroundStyle(.tertiary)
                            Text("No Alerts").font(.headline).foregroundStyle(.secondary)
                            Text("Pull down on Analysis to generate trade setups, or tap + to create manually.")
                                .font(.caption).foregroundStyle(.tertiary)
                                .multilineTextAlignment(.center).padding(.horizontal, 40)
                        }
                        .padding(.vertical, 60)
                    }
                }
                .padding(.vertical, 12)
                .padding(.horizontal)
            }
            .background(Color(.systemGroupedBackground))
            .refreshable { regenerateAlerts() }
            .navigationTitle("Price Alerts")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if !alertsStore.alerts.isEmpty {
                        Button("Clear All") { withAnimation { alertsStore.clearAll() } }
                            .foregroundStyle(.red)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showCreateAlert = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showCreateAlert) { CreateAlertView() }
    }

    private func removeGroup(_ group: SetupGroup) {
        for alert in group.alerts { alertsStore.removeAlert(id: alert.id) }
    }

    private func groupedSetups(direction: String) -> [SetupGroup] {
        let matching = alertsStore.alerts.filter { $0.note.contains(direction) && !$0.triggered }
        var groups = [UUID: [PriceAlert]]()
        var orphans = [String: [PriceAlert]]()
        for alert in matching {
            if let sid = alert.setupId {
                groups[sid, default: []].append(alert)
            } else {
                orphans[alert.symbol, default: []].append(alert)
            }
        }

        // Helper to find matching TradeSetup and current price for a symbol
        func lookupSetup(symbol: String, direction: String) -> (TradeSetup?, Double?) {
            guard let result = service.cachedResults[symbol] else { return (nil, nil) }
            let setup = result.tradeSetups.first { $0.direction == direction }
            return (setup, result.daily.price)
        }

        var result = groups.map { sid, alerts -> SetupGroup in
            let sorted = alerts.sorted { alertOrder($0.note) < alertOrder($1.note) }
            let symbol = sorted.first?.symbol ?? ""
            let (setup, price) = lookupSetup(symbol: symbol, direction: direction)
            return SetupGroup(setupId: sid, direction: direction, alerts: sorted, setup: setup, currentPrice: price)
        }
        for (_, alerts) in orphans {
            let sorted = alerts.sorted { alertOrder($0.note) < alertOrder($1.note) }
            let symbol = sorted.first?.symbol ?? ""
            let (setup, price) = lookupSetup(symbol: symbol, direction: direction)
            result.append(SetupGroup(setupId: UUID(), direction: direction, alerts: sorted, setup: setup, currentPrice: price))
        }
        return result.sorted { ($0.alerts.first?.createdAt ?? .distantPast) > ($1.alerts.first?.createdAt ?? .distantPast) }
    }

    private func alertOrder(_ note: String) -> Int {
        if note.contains("entry") { return 0 }
        if note.contains("stop") { return 1 }
        if note.contains("TP1") { return 2 }
        if note.contains("TP2") { return 3 }
        return 4
    }

    /// Clear old setup alerts and regenerate from the latest cached analysis.
    private func regenerateAlerts() {
        // Remove all existing setup alerts (keep custom + triggered)
        alertsStore.alerts.removeAll { $0.note.contains("LONG") || $0.note.contains("SHORT") }

        // Regenerate from all cached results
        for (_, result) in service.cachedResults {
            guard !result.tradeSetups.isEmpty else { continue }
            let price = result.daily.price
            let newAlerts = result.tradeSetups.flatMap { $0.toAlerts(symbol: result.symbol, currentPrice: price) }
            for alert in newAlerts {
                alertsStore.addAlert(alert)
            }
        }
    }
}

private struct SetupGroup: Identifiable {
    let setupId: UUID
    let direction: String
    let alerts: [PriceAlert]
    let setup: TradeSetup?
    let currentPrice: Double?
    var id: UUID { setupId }
}

// MARK: - Setup Card (matches analysis table style)

private struct SetupCard: View {
    let group: SetupGroup
    let direction: String
    let onDismiss: () -> Void
    var onViewAnalysis: (() -> Void)?
    @State private var showReasoning = false

    private var accentColor: Color { direction == "LONG" ? .green : .red }
    private var icon: String { direction == "LONG" ? "arrow.up.right" : "arrow.down.right" }
    private var assetName: String {
        let sym = group.alerts.first?.symbol ?? ""
        return Constants.asset(for: sym)?.name ?? sym
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header — text only, like analysis screen
            HStack {
                Image(systemName: icon).font(.caption).fontWeight(.bold)
                Text("\(direction) Setup").font(.subheadline).fontWeight(.bold)
                Text("\u{00B7}").foregroundStyle(.secondary)
                Text(assetName).font(.subheadline).fontWeight(.medium).foregroundStyle(.secondary)
                Spacer()
                Button(action: {
                    HapticManager.impact(.light)
                    onDismiss()
                }) {
                    Image(systemName: "xmark").font(.caption2).fontWeight(.bold)
                        .foregroundStyle(.secondary).padding(5)
                        .background(Color(.systemGray5), in: Circle())
                }
            }
            .foregroundStyle(accentColor)
            .padding(.horizontal, 14).padding(.vertical, 10)

            // Table — matches the analysis screen table exactly
            VStack(spacing: 0) {
                // Header row
                HStack(spacing: 0) {
                    Text("Level").frame(width: 70, alignment: .leading)
                    Spacer()
                    Text("Price").frame(width: 100, alignment: .trailing)
                    Text("R:R").frame(width: 50, alignment: .trailing)
                    Text("").frame(width: 24)
                }
                .font(.caption).fontWeight(.bold).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Color(.systemGray5))

                // Alert rows
                ForEach(Array(group.alerts.enumerated()), id: \.element.id) { idx, alert in
                    let label = alert.note
                        .replacingOccurrences(of: "LONG ", with: "")
                        .replacingOccurrences(of: "SHORT ", with: "")
                    let badgeColor = colorFor(label)

                    VStack(spacing: 0) {
                        HStack(spacing: 0) {
                            // Level badge
                            Text(label)
                                .font(.caption).fontWeight(.bold)
                                .foregroundStyle(badgeColor)
                                .frame(width: 70, alignment: .leading)

                            Spacer()

                            // Price + distance
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(Formatters.formatPrice(alert.targetPrice))
                                    .font(.callout).fontWeight(.medium).monospacedDigit()
                                if let price = group.currentPrice, price > 0 {
                                    let dist = alert.targetPrice - price
                                    let pct = (dist / price) * 100
                                    Text("\(Formatters.formatPrice(abs(dist))) (\(String(format: "%.1f%%", abs(pct))))")
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                            .frame(width: 100, alignment: .trailing)

                            // R:R column
                            Text(rrText(for: label))
                                .font(.caption).fontWeight(.medium).monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 50, alignment: .trailing)

                            // Direction indicator
                            Text(alert.condition.symbol)
                                .font(.caption).foregroundStyle(.tertiary)
                                .frame(width: 24, alignment: .trailing)
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(badgeColor.opacity(0.06))

                    if idx < group.alerts.count - 1 {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(Color(.secondarySystemGroupedBackground))

            // Reasoning + View Analysis
            VStack(spacing: 0) {
                if let reasoning = group.setup?.reasoning, !reasoning.isEmpty {
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) { showReasoning.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "lightbulb").font(.caption2)
                            Text("Reasoning")
                                .font(.caption2).fontWeight(.semibold)
                            Spacer()
                            Text(showReasoning ? "Hide" : "Show")
                                .font(.caption2)
                            Image(systemName: showReasoning ? "chevron.up" : "chevron.down")
                                .font(.caption2)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                    }
                    .buttonStyle(.borderless)

                    if showReasoning {
                        Text(reasoning)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14).padding(.bottom, 8)
                            .transition(.opacity)
                    }
                }

                if let onViewAnalysis {
                    Divider().padding(.leading, 14)
                    Button {
                        onViewAnalysis()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chart.line.uptrend.xyaxis").font(.caption2)
                            Text("View Analysis").font(.caption2).fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption2)
                        }
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.systemGray4), lineWidth: 0.5))
    }

    private func rrText(for label: String) -> String {
        guard let setup = group.setup else { return "\u{2014}" }
        let l = label.lowercased()
        if l.contains("tp1") {
            return String(format: "1:%.1f", setup.rrTP1)
        } else if l.contains("tp2"), let rr = setup.rrTP2 {
            return String(format: "1:%.1f", rr)
        }
        return "\u{2014}"
    }

    private func colorFor(_ label: String) -> Color {
        let l = label.lowercased()
        if l.contains("entry") { return .accentColor }
        if l.contains("stop") { return .red }
        if l.contains("tp") { return .green }
        return .secondary
    }
}

// MARK: - Custom / Triggered / Create

private struct CustomAlertCard: View {
    let alert: PriceAlert
    let onDismiss: () -> Void
    var body: some View {
        let assetName = Constants.asset(for: alert.symbol)?.ticker ?? alert.symbol
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(assetName).font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                Text("\(alert.condition.symbol) \(Formatters.formatPrice(alert.targetPrice))")
                    .font(.subheadline).fontWeight(.medium)
                if !alert.note.isEmpty { Text(alert.note).font(.caption2).foregroundStyle(.tertiary) }
            }
            Spacer()
            Button(action: {
                HapticManager.impact(.light)
                onDismiss()
            }) {
                Image(systemName: "xmark").font(.caption2).fontWeight(.bold).foregroundStyle(.secondary)
                    .padding(6).background(Color(.systemGray5), in: Circle())
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct TriggeredRow: View {
    let alert: PriceAlert
    let onDismiss: () -> Void
    var body: some View {
        let assetName = Constants.asset(for: alert.symbol)?.ticker ?? alert.symbol
        let label = alert.note.replacingOccurrences(of: "LONG ", with: "").replacingOccurrences(of: "SHORT ", with: "")
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
            Text(assetName).font(.caption).foregroundStyle(.tertiary)
            Text(label).font(.caption2).foregroundStyle(.tertiary)
            Text(Formatters.formatPrice(alert.targetPrice)).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark").font(.caption2).foregroundStyle(.quaternary)
                    .padding(4).background(Color(.systemGray5), in: Circle())
            }
        }
        .padding(.vertical, 4)
    }
}

struct CreateAlertView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @Environment(\.dismiss) private var dismiss
    @State private var selectedSymbol = Constants.allCoins[0].id
    @State private var priceText = ""
    @State private var condition: PriceAlert.Condition = .above
    @State private var note = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Asset") {
                    Picker("Asset", selection: $selectedSymbol) {
                        Section("Crypto") {
                            ForEach(Constants.allCoins) { coin in
                                Text("\(coin.name) (\(coin.ticker))").tag(coin.id)
                            }
                        }
                        Section("Stocks & ETFs") {
                            ForEach(Constants.defaultStocks) { stock in
                                Text("\(stock.name) (\(stock.ticker))").tag(stock.id)
                            }
                        }
                    }
                }
                Section("Condition") {
                    Picker("When price is", selection: $condition) {
                        ForEach(PriceAlert.Condition.allCases, id: \.self) { c in Text(c.label).tag(c) }
                    }.pickerStyle(.segmented)
                    HStack {
                        Text("Target Price ($)")
                        TextField("0.00", text: $priceText).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                }
                Section("Note (optional)") { TextField("e.g., Long entry", text: $note) }
            }
            .navigationTitle("New Alert").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        if let price = Double(priceText), price > 0 {
                            alertsStore.addAlert(PriceAlert(symbol: selectedSymbol, targetPrice: price, condition: condition, note: note))
                            dismiss()
                        }
                    }.disabled(Double(priceText) == nil)
                }
            }
        }
    }
}
