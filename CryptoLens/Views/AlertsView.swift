import SwiftUI

struct AlertsView: View {
    @EnvironmentObject var alertsStore: AlertsStore
    @EnvironmentObject var service: AnalysisService
    @State private var showCreateAlert = false

    private var longSetups: [SetupGroup] { groupedSetups(direction: "LONG") }
    private var shortSetups: [SetupGroup] { groupedSetups(direction: "SHORT") }
    private var customAlerts: [PriceAlert] {
        alertsStore.alerts.filter { !$0.note.contains("LONG") && !$0.note.contains("SHORT") && !$0.triggered }
    }
    private var triggeredAlerts: [PriceAlert] { alertsStore.alerts.filter(\.triggered) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(longSetups) { group in
                        SetupCard(group: group, direction: "LONG") {
                            withAnimation(.easeOut(duration: 0.25)) { removeGroup(group) }
                        }
                    }

                    ForEach(shortSetups) { group in
                        SetupCard(group: group, direction: "SHORT") {
                            withAnimation(.easeOut(duration: 0.25)) { removeGroup(group) }
                        }
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
        var result = groups.map { sid, alerts in
            SetupGroup(setupId: sid, direction: direction, alerts: alerts.sorted { alertOrder($0.note) < alertOrder($1.note) })
        }
        for (_, alerts) in orphans {
            result.append(SetupGroup(setupId: UUID(), direction: direction, alerts: alerts.sorted { alertOrder($0.note) < alertOrder($1.note) }))
        }
        return result.sorted { ($0.alerts.first?.createdAt ?? .distantPast) > ($1.alerts.first?.createdAt ?? .distantPast) }
    }

    private func alertOrder(_ note: String) -> Int {
        if note.contains("entry") { return 0 }
        if note.contains("stop") { return 1 }
        if note.contains("TP1") { return 2 }
        if note.contains("TP2") { return 3 }
        if note.contains("TP3") { return 4 }
        return 5
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
    var id: UUID { setupId }
}

// MARK: - Setup Card (matches analysis table style)

private struct SetupCard: View {
    let group: SetupGroup
    let direction: String
    let onDismiss: () -> Void

    private var accentColor: Color { direction == "LONG" ? .green : .red }
    private var icon: String { direction == "LONG" ? "arrow.up.right" : "arrow.down.right" }
    private var coinName: String { Constants.coin(for: group.alerts.first?.symbol ?? "")?.name ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            // Header — text only, like analysis screen
            HStack {
                Image(systemName: icon).font(.caption).fontWeight(.bold)
                Text("\(direction) Setup").font(.subheadline).fontWeight(.bold)
                Text("·").foregroundStyle(.secondary)
                Text(coinName).font(.subheadline).fontWeight(.medium).foregroundStyle(.secondary)
                Spacer()
                Button(action: onDismiss) {
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
                    Text("Level").frame(width: 90, alignment: .leading)
                    Spacer()
                    Text("Price").frame(width: 120, alignment: .trailing)
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

                    HStack(spacing: 0) {
                        // Level badge (colored, like analysis **Entry** etc.)
                        Text(label)
                            .font(.caption).fontWeight(.bold)
                            .foregroundStyle(badgeColor)
                            .frame(width: 90, alignment: .leading)

                        Spacer()

                        // Price
                        Text(Formatters.formatPrice(alert.targetPrice))
                            .font(.callout).fontWeight(.medium).monospacedDigit()
                            .frame(width: 120, alignment: .trailing)

                        // Direction indicator
                        Text(alert.condition.symbol)
                            .font(.caption).foregroundStyle(.tertiary)
                            .frame(width: 24, alignment: .trailing)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(badgeColor.opacity(0.06))

                    if idx < group.alerts.count - 1 {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(Color(.secondarySystemGroupedBackground))
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.systemGray4), lineWidth: 0.5))
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
        let coinName = Constants.coin(for: alert.symbol)?.ticker ?? alert.symbol
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(coinName).font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                Text("\(alert.condition.symbol) \(Formatters.formatPrice(alert.targetPrice))")
                    .font(.subheadline).fontWeight(.medium)
                if !alert.note.isEmpty { Text(alert.note).font(.caption2).foregroundStyle(.tertiary) }
            }
            Spacer()
            Button(action: onDismiss) {
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
        let coinName = Constants.coin(for: alert.symbol)?.ticker ?? alert.symbol
        let label = alert.note.replacingOccurrences(of: "LONG ", with: "").replacingOccurrences(of: "SHORT ", with: "")
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
            Text(coinName).font(.caption).foregroundStyle(.tertiary)
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
                Section("Coin") {
                    Picker("Coin", selection: $selectedSymbol) {
                        ForEach(Constants.allCoins) { coin in
                            Text("\(coin.name) (\(coin.ticker))").tag(coin.id)
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
