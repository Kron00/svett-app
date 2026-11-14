import Foundation

/// Everything the app keeps about the account. It is stored as one Keychain item and nowhere else.
struct Vault: Codable, Equatable, Sendable {
    /// Names this install to OpenAI. It is made once and outlives a sign-out.
    var hostID = UUID()
    /// The client id that the first sign-in was issued. It belongs to one ChatGPT user.
    var clientID: String?
    var session: Session?

    struct Session: Codable, Equatable, Sendable {
        var accessToken: String
        var refreshToken: String
        var scope: String
        var expiresAt: Date
        var email: String?
    }
}

/// What JavaScript may see of the account. It never carries a token.
struct SessionSummary: Sendable {
    let scope: String
    let expiresAt: Date

    var record: [String: Any] {
        ["scope": scope, "expiresAt": expiresAt.timeIntervalSince1970 * 1000]
    }
}

/// The ChatGPT sign-in: what is stored, and how the code is exchanged for tokens. It is an actor so
/// that the Keychain and the token responses are never handled on the main thread.
actor ChatGPTAccount {
    private let store: KeychainVaultStore
    private let now: @Sendable () -> Date
    private lazy var vault = store.load() ?? Vault()

    /// What OpenAI documents for an access token, for an answer that does not say.
    private static let documentedLifetime: TimeInterval = 3600

    init(store: KeychainVaultStore, now: @escaping @Sendable () -> Date = { .now }) {
        self.store = store
        self.now = now
    }

    var session: SessionSummary? {
        vault.session.map { SessionSummary(scope: $0.scope, expiresAt: $0.expiresAt) }
    }

    func beginSignIn(port: UInt16) -> (attempt: SignInAttempt, page: URL) {
        // A new install has just made its host id. It has to be the same one at the next sign-in.
        store.save(vault)
        let attempt = SignInAttempt(port: port, clientID: vault.clientID)
        return (attempt, attempt.authorizeURL(hostID: vault.hostID, askAgain: false))
    }

    func finishSignIn(_ attempt: SignInAttempt, _ grant: SignInGrant) async throws(SignInProblem) {
        let reply: (data: Data, response: URLResponse)
        do {
            reply = try await URLSession(configuration: .ephemeral).data(for: attempt.exchange(grant))
        } catch {
            throw .unreachable
        }
        guard (reply.response as? HTTPURLResponse)?.statusCode == 200, let tokens = TokenResponse(body: reply.data),
              let refreshToken = tokens.refreshToken,
              let claims = tokens.idToken.flatMap(IDTokenClaims.init), claims.nonce == attempt.nonce
        else { throw .refused }
        // The user cancelled while the code was exchanged. A cancelled sign-in keeps nothing.
        if Task.isCancelled { return }
        vault.clientID = grant.clientID
        vault.session = Vault.Session(
            accessToken: tokens.accessToken, refreshToken: refreshToken, scope: tokens.scope ?? "",
            expiresAt: now().addingTimeInterval(tokens.expiresIn ?? Self.documentedLifetime), email: claims.email)
        store.save(vault)
    }
}
