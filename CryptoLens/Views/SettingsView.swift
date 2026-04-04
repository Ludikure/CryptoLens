import SwiftUI
import Security

struct SettingsView: View {
    @EnvironmentObject var service: AnalysisService
    @StateObject private var status = ConnectionStatus.shared
    @State private var selectedProvider: AIProviderType = .claude
    @State private var selectedModel: String = ""
    @State private var autoAlerts = UserDefaults.standard.object(forKey: "auto_alerts_enabled") as? Bool ?? false
    @AppStorage("colorSchemeOverride") private var colorSchemeOverride = "system"

    var body: some View {
        NavigationStack {
            Form {
                // Connection status
                Section {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                        Text(status.overallState)
                            .font(.subheadline)
                        Spacer()
                        if status.pendingOfflineChanges {
                            Text("Pending sync")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.12), in: Capsule())
                        }
                    }

                    // Source health badges
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 8) {
                        sourceBadge("Yahoo", state: status.yahooFinance)
                        sourceBadge("Binance", state: status.binance)
                        sourceBadge("Finnhub", state: status.finnhub)
                        sourceBadge("FRED", state: status.macro)
                        sourceBadge("AI", state: status.ai)
                        sourceBadge("Auth", state: status.workerAuth)
                    }
                } header: {
                    Text("Status")
                }

                // AI Provider + Model
                Section("AI Provider") {
                    Picker("Provider", selection: $selectedProvider) {
                        ForEach(AIProviderType.allCases) { type in
                            Text(type.displayName).tag(type)
                        }
                    }
                    .onChange(of: selectedProvider) {
                        updateModel()
                        configureService()
                    }

                    Picker("Model", selection: $selectedModel) {
                        ForEach(selectedProvider.models, id: \.id) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .onChange(of: selectedModel) {
                        configureService()
                    }
                }

                // Alerts
                Section {
                    Toggle("Auto-generate alerts from trade setups", isOn: $autoAlerts)
                        .onChange(of: autoAlerts) {
                            UserDefaults.standard.set(autoAlerts, forKey: "auto_alerts_enabled")
                        }
                } header: {
                    Text("Alerts")
                } footer: {
                    Text("When enabled, running AI analysis will automatically create price alerts for Entry, Stop Loss, and Take Profit levels.")
                }

                // Notifications
                Section {
                    Toggle("Notify on bias changes", isOn: Binding(
                        get: { UserDefaults.standard.bool(forKey: "notify_bias_flips") },
                        set: { UserDefaults.standard.set($0, forKey: "notify_bias_flips") }
                    ))
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Get notified when a favorited asset's daily bias changes (e.g., Bearish \u{2192} Bullish).")
                }

                // Appearance
                Section("Appearance") {
                    Picker("Theme", selection: $colorSchemeOverride) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Data") {
                    NavigationLink("Outcome Tracking") {
                        OutcomeDashboardView()
                    }
                }

                // About
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?").foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Build")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 10) {
                            Image("SplashLogo")
                                .resizable()
                                .frame(width: 40, height: 40)
                                .clipShape(RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("MarketScope")
                                    .font(.headline)
                                Text("Multi-Timeframe Technical Analysis")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Divider()

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Data Sources")
                                .font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
                            Text("Stocks: Yahoo Finance (candles, fundamentals, sentiment, options)")
                                .font(.caption2).foregroundStyle(.tertiary)
                            Text("Enrichment: Finnhub (analyst consensus, beta, news)")
                                .font(.caption2).foregroundStyle(.tertiary)
                            Text("Crypto: Binance (primary) · Coinbase (fallback) · CoinGecko (tertiary)")
                                .font(.caption2).foregroundStyle(.tertiary)
                            Text("Macro: FRED (VIX, yields, fed funds, USD index)")
                                .font(.caption2).foregroundStyle(.tertiary)
                            Text("Calendar: FairEconomy (economic events)")
                                .font(.caption2).foregroundStyle(.tertiary)
                            Text("AI: Claude (Anthropic) · Gemini (Google)")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }

                        Text("Made by Ludikure")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                selectedProvider = service.providerType
                updateModel()
            }
        }
    }

    private var statusColor: Color {
        switch status.overallColor {
        case "green": return .green
        case "orange": return .orange
        case "red": return .red
        default: return .gray
        }
    }

    private func sourceBadge(_ name: String, state: ConnectionStatus.SourceState) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(state == .ok ? .green : (state == .error ? .red : (state == .pending ? .orange : .gray)))
                .frame(width: 6, height: 6)
            Text(name)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func updateModel() {
        if selectedModel.isEmpty || !selectedProvider.models.contains(where: { $0.id == selectedModel }) {
            selectedModel = selectedProvider.models[0].id
        }
    }

    private func configureService() {
        service.configure(provider: selectedProvider, apiKey: "", model: selectedModel)
        UserDefaults.standard.set(selectedProvider.rawValue, forKey: "ai_provider")
    }
}

// MARK: - Keychain Helper

enum KeychainHelper {
    static func save(key: String, value: String) {
        let data = value.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
