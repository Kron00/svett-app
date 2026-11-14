import Foundation

/// Everything the app keeps about ChatGPT. It is stored as one Keychain item and nowhere else.
struct Vault: Codable, Equatable, Sendable {
    /// Names this install to OpenAI. It is made once and outlives every sign-out.
    var hostID = UUID()
    /// Each ChatGPT account this install has signed in to, the one used last at the end. A sign-out
    /// keeps the account's issued client ID, so the next sign-in to it registers nothing new.
    var registrations: [Registration] = []
    /// The signed-in session. It belongs to the registration with the same client ID.
    var session: Session?
    /// Why the last session ended, when OpenAI ended it rather than the user.
    var ended: SessionEnd?

    struct Registration: Codable, Equatable, Sendable {
        let clientID: String
        /// The account's verified `sub`. Nil only for a registration kept from before ID tokens were checked.
        var subject: String?
        var email: String?
        /// The last verified ID token, sent back as `id_token_hint` so the next sign-in skips the
        /// account picker. A sign-out forgets it.
        var idToken: String?
    }

    struct Session: Codable, Equatable, Sendable {
        let clientID: String
        var accessToken: String
        var refreshToken: String?
        var scope: String
        var expiresAt: Date
        /// When a refresh last replaced the tokens. The app records that a refresh happened, never the token.
        var renewedAt: Date?

        var allowsPlanUsage: Bool {
            scope.split(separator: " ").contains { $0 == OpenAI.planUsageScope }
        }
    }

    init(hostID: UUID = UUID(), registrations: [Registration] = [], session: Session? = nil, ended: SessionEnd? = nil) {
        self.hostID = hostID
        self.registrations = registrations
        self.session = session
        self.ended = ended
    }

    func registration(_ clientID: String) -> Registration? {
        registrations.first { $0.clientID == clientID }
    }

    /// Puts `registration` last, in place of any with its client ID.
    mutating func keep(_ registration: Registration) {
        registrations.removeAll { $0.clientID == registration.clientID }
        registrations.append(registration)
    }

    private enum CodingKeys: String, CodingKey {
        case hostID, registrations, session, ended
        /// The one client ID F3's vault kept.
        case clientID
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostID = try container.decode(UUID.self, forKey: .hostID)
        if let registrations = try container.decodeIfPresent([Registration].self, forKey: .registrations) {
            self.registrations = registrations
            session = try container.decodeIfPresent(Session.self, forKey: .session)
            ended = try container.decodeIfPresent(SessionEnd.self, forKey: .ended)
        } else if let clientID = try container.decodeIfPresent(String.self, forKey: .clientID) {
            // F3 never checked its ID token's signature, so its session is dropped. Its client ID is
            // kept, so signing in again reuses the registration instead of adding a second app.
            registrations = [Registration(clientID: clientID)]
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostID, forKey: .hostID)
        try container.encode(registrations, forKey: .registrations)
        try container.encodeIfPresent(session, forKey: .session)
        try container.encodeIfPresent(ended, forKey: .ended)
    }
}

enum SessionEnd: String, Codable, Sendable {
    /// OpenAI said the refresh token can never be used again, as after 30 days without use.
    case lapsed
    /// OpenAI no longer accepts the issued client ID, so the next sign-in registers again.
    case clientRefused
}

/// Where the vault is kept: the Keychain in the app, memory in tests and the stand-in mode.
protocol VaultStore: Sendable {
    func load() -> Vault?
    func save(_ vault: Vault)
}

final class MemoryVaultStore: VaultStore, @unchecked Sendable {
    private let lock = NSLock()
    private var vault: Vault?

    init(_ vault: Vault? = nil) {
        self.vault = vault
    }

    func load() -> Vault? { lock.withLock { vault } }

    func save(_ vault: Vault) { lock.withLock { self.vault = vault } }
}
