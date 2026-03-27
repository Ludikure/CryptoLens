import SwiftUI
import Security

struct SettingsView: View {
    @EnvironmentObject var service: AnalysisService
    @State private var apiKey = ""
    @State private var useHaiku = false
    @State private var showKey = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        if showKey {
                            TextField("sk-ant-...", text: $apiKey)
                                .font(.system(.body, design: .monospaced))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        } else {
                            SecureField("sk-ant-...", text: $apiKey)
                                .font(.system(.body, design: .monospaced))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        Button {
                            showKey.toggle()
                        } label: {
                            Image(systemName: showKey ? "eye.slash" : "eye")
                        }
                    }
                    Button("Save API Key") {
                        KeychainHelper.save(key: "claude_api_key", value: apiKey)
                        configureService()
                    }
                    .disabled(apiKey.isEmpty)
                } header: {
                    Text("Claude API Key")
                } footer: {
                    Text("Your key is stored securely in the iOS Keychain.")
                }

                Section("Model") {
                    Toggle("Use Haiku (faster, cheaper)", isOn: $useHaiku)
                        .onChange(of: useHaiku) { configureService() }
                    Text(useHaiku ? Constants.haikuModel : Constants.defaultModel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                // Load from Keychain first, fall back to build-time xcconfig key
                if let saved = KeychainHelper.load(key: "claude_api_key"), !saved.isEmpty {
                    apiKey = saved
                } else if let buildKey = Bundle.main.infoDictionary?["ClaudeAPIKey"] as? String,
                          !buildKey.isEmpty, buildKey != "your-key-here" {
                    apiKey = buildKey
                    KeychainHelper.save(key: "claude_api_key", value: buildKey)
                }
                configureService()
            }
        }
    }

    private func configureService() {
        let key = KeychainHelper.load(key: "claude_api_key") ?? apiKey
        guard !key.isEmpty else { return }
        let model = useHaiku ? Constants.haikuModel : Constants.defaultModel
        service.configure(apiKey: key, model: model)
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
