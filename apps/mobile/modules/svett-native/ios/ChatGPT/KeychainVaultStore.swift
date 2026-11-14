import Foundation
import Security

/// The vault as one generic-password item. It is readable after the first unlock, so a token can be
/// refreshed while the phone is locked, and it never leaves this device in a backup.
struct KeychainVaultStore: VaultStore {
    var account = "vault"

    struct Failure: Error {
        let status: OSStatus
    }

    private var item: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.kron00.svett.chatgpt",
            kSecAttrAccount: account,
        ]
    }

    func load() throws -> Vault? {
        var query = item
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data else { throw Failure(status: status) }
        // A vault that cannot be decoded can never be read again, so it counts as none and the next
        // save replaces it.
        return try? JSONDecoder().decode(Vault.self, from: data)
    }

    func save(_ vault: Vault) throws {
        let data = try JSONEncoder().encode(vault)
        let updated = SecItemUpdate(item as CFDictionary, [kSecValueData: data] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw Failure(status: updated) }
        var new = item
        new[kSecValueData] = data
        new[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(new as CFDictionary, nil)
        guard added == errSecSuccess else { throw Failure(status: added) }
    }
}
