import Foundation
import Security

/// The vault as one generic-password item. It is readable after the first unlock, so a token can be
/// refreshed while the phone is locked, and it never leaves this device in a backup.
struct KeychainVaultStore: Sendable {
    var account = "vault"

    private var item: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.kron00.svett.chatgpt",
            kSecAttrAccount: account,
        ]
    }

    func load() -> Vault? {
        var query = item
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(Vault.self, from: data)
    }

    func save(_ vault: Vault) {
        guard let data = try? JSONEncoder().encode(vault) else { return }
        guard SecItemUpdate(item as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecItemNotFound else { return }
        var new = item
        new[kSecValueData] = data
        new[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(new as CFDictionary, nil)
    }
}
