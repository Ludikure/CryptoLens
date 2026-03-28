import SwiftUI
import Security

struct SettingsView: View {
    @EnvironmentObject var service: AnalysisService
    @State private var selectedProvider: AIProviderType = .claude
    @State private var selectedModel: String = ""
    @State private var apiKey = ""
    @State private var showKey = false

    var body: some View {
        NavigationStack {
            Form {
                // Provider selection
                Section("AI Provider") {
                    Picker("Provider", selection: $selectedProvider) {
                        ForEach(AIProviderType.allCases) { type in
                            Text(type.displayName).tag(type)
                        }
                    }
                    .onChange(of: selectedProvider) {
                        loadKeyForProvider()
                    }
                }

                // API Key
                Section {
                    HStack {
                        if showKey {
                            TextField(keyPlaceholder, text: $apiKey)
                                .font(.system(.body, design: .monospaced))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        } else {
                            SecureField(keyPlaceholder, text: $apiKey)
                                .font(.system(.body, design: .monospaced))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        Button { showKey.toggle() } label: {
                            Image(systemName: showKey ? "eye.slash" : "eye")
                        }
                    }
                    Button("Save API Key") {
                        KeychainHelper.save(key: selectedProvider.keychainKey, value: apiKey)
                        UserDefaults.standard.set(selectedProvider.rawValue, forKey: "ai_provider")
                        configureService()
                    }
                    .disabled(apiKey.isEmpty)
                } header: {
                    Text("\(selectedProvider.displayName) API Key")
                } footer: {
                    Text("Your key is stored securely in the iOS Keychain.")
                }

                // Model selection
                Section("Model") {
                    Picker("Model", selection: $selectedModel) {
                        ForEach(selectedProvider.models, id: \.id) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .onChange(of: selectedModel) {
                        configureService()
                    }
                    Text(selectedModel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0").foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Active Provider")
                        Spacer()
                        Text(service.providerType.displayName).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                selectedProvider = service.providerType
                loadKeyForProvider()
                if selectedModel.isEmpty {
                    selectedModel = selectedProvider.models[0].id
                }
            }
        }
    }

    private var keyPlaceholder: String {
        switch selectedProvider {
        case .claude: return "sk-ant-..."
        case .gemini: return "AIza..."
        }
    }

    private func loadKeyForProvider() {
        apiKey = KeychainHelper.load(key: selectedProvider.keychainKey) ?? ""
        if apiKey.isEmpty {
            if let buildKey = Bundle.main.infoDictionary?[selectedProvider.infoPlistKey] as? String,
               !buildKey.isEmpty, !buildKey.contains("API_KEY") {
                apiKey = buildKey
            }
        }
        if selectedModel.isEmpty || !selectedProvider.models.contains(where: { $0.id == selectedModel }) {
            selectedModel = selectedProvider.models[0].id
        }
    }

    private func configureService() {
        guard !apiKey.isEmpty else { return }
        service.configure(provider: selectedProvider, apiKey: apiKey, model: selectedModel)
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
