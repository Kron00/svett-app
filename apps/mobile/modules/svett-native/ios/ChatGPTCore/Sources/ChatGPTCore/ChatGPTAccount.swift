import Foundation

/// What JavaScript may know of the account. It never carries a token.
enum AccountStatus: Equatable, Sendable {
    case signedIn(email: String?, scope: String, expiresAt: Date, renewedAt: Date?)
    /// `returning` is set when a saved registration exists, with its email when known.
    case signedOut(returning: Returning?, ended: SessionEnd?)

    struct Returning: Equatable, Sendable {
        let email: String?
    }

    /// The status as JavaScript reads it. A value that is not there is left out.
    var record: [String: Any] {
        var record: [String: Any]
        switch self {
        case let .signedIn(email, scope, expiresAt, renewedAt):
            record = [
                "state": "signedIn",
                "scope": scope,
                "planUsage": scope.split(separator: " ").contains { $0 == OpenAI.planUsageScope },
                "expiresAt": expiresAt.timeIntervalSince1970 * 1000,
            ]
            if let email { record["email"] = email }
            if let renewedAt { record["renewedAt"] = renewedAt.timeIntervalSince1970 * 1000 }
        case let .signedOut(returning, ended):
            record = ["state": "signedOut"]
            if let returning {
                var account: [String: Any] = [:]
                if let email = returning.email { account["email"] = email }
                record["returning"] = account
            }
            if let ended { record["ended"] = ended.rawValue }
        }
        return record
    }
}

/// Why the app has no token to send.
enum AccountProblem: Error, Equatable, Sendable {
    case signedOut
    case planUsageOff
    /// OpenAI ended the session, and it was cleared. The user has to sign in again.
    case signInAgain(SessionEnd)
    /// OpenAI turned the refresh down for a reason it does not document. The session is kept.
    case refused(String?)
    /// OpenAI could not be reached, or answered with a server error. The session is kept.
    case unreachable

    var code: String {
        switch self {
        case .signedOut: "signedOut"
        case .planUsageOff: "planUsageOff"
        case .signInAgain(let end): end.rawValue
        case .refused: "refused"
        case .unreachable: "unreachable"
        }
    }
}

/// The ChatGPT sign-in: what is stored, and how tokens are exchanged, checked, refreshed and
/// revoked. It is an actor so that the Keychain and the token answers are never handled on the
/// main thread, and so that one refresh runs at a time.
actor ChatGPTAccount {
    private let transport: any OpenAITransport
    private let store: any VaultStore
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async -> Void
    private lazy var vault = store.load() ?? Vault()
    private var refresh: Task<Result<Vault.Session, AccountProblem>, Never>?

    /// A token this close to its end is replaced before use, so a request never starts with one
    /// that expires on the way.
    static let refreshMargin: TimeInterval = 120
    /// What OpenAI documents for an access token, for an answer that does not say.
    static let documentedLifetime: TimeInterval = 3600
    /// The waits before each retry of a revocation that met a network failure or a server error.
    static let revokeRetryWaits: [Duration] = [.seconds(1), .seconds(3)]

    init(transport: any OpenAITransport, store: any VaultStore, now: @escaping @Sendable () -> Date = { .now },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.transport = transport
        self.store = store
        self.now = now
        self.sleep = sleep
    }

    var status: AccountStatus {
        if let session = vault.session {
            return .signedIn(email: vault.registration(session.clientID)?.email, scope: session.scope,
                             expiresAt: session.expiresAt, renewedAt: session.renewedAt)
        }
        return .signedOut(returning: vault.registrations.last.map { .init(email: $0.email) }, ended: vault.ended)
    }

    func beginSignIn(port: UInt16, choice: SignInChoice) -> (attempt: SignInAttempt, page: URL) {
        // A new install has just made its host id. It has to be the same one at the next sign-in.
        store.save(vault)
        let registration: Vault.Registration? = switch choice {
        case .returning: vault.registrations.last
        case .anotherAccount: nil
        case .allowPlanUsage: vault.session.flatMap { vault.registration($0.clientID) } ?? vault.registrations.last
        }
        let attempt = SignInAttempt(port: port, registration: registration, askAgain: choice == .allowPlanUsage)
        return (attempt, attempt.authorizeURL(hostID: vault.hostID))
    }

    /// Exchanges the code, checks the ID token, and keeps the tokens with their registration. A
    /// token that fails a check leaves the vault as it was.
    func finishSignIn(_ attempt: SignInAttempt, _ grant: SignInGrant) async -> SignInProblem? {
        let tokens: TokenResponse
        switch await tokenAnswer(attempt.exchange(grant)) {
        case .tokens(let answer): tokens = answer
        case .unusableGrant:
            // OpenAI's cookbook: keep a newly issued client ID when its code fails, so the next try
            // does not register a second app.
            if vault.registration(grant.clientID) == nil {
                vault.keep(Vault.Registration(clientID: grant.clientID))
                store.save(vault)
            }
            return .codeExpired
        case .invalidClient:
            vault.registrations.removeAll { $0.clientID == grant.clientID }
            store.save(vault)
            return .clientRefused
        case .rejected: return .refused
        case .unavailable: return .unreachable
        }
        guard let idToken = tokens.idToken else { return .identity(.malformed) }
        guard let reply = try? await transport.send(URLRequest(url: OpenAI.keys)), reply.status == 200,
              let keys = KeySet(body: reply.body) else { return .unreachable }
        let identity: VerifiedIdentity
        switch IDToken.verify(idToken, keys: keys, clientID: grant.clientID, nonce: attempt.nonce, now: now()) {
        case .success(let verified): identity = verified
        case .failure(let problem): return .identity(problem)
        }
        var registration = vault.registration(grant.clientID) ?? Vault.Registration(clientID: grant.clientID)
        if let subject = registration.subject, subject != identity.subject { return .otherAccount }
        // The user cancelled while the code was exchanged. A cancelled sign-in keeps nothing.
        if Task.isCancelled { return nil }
        registration.subject = identity.subject
        registration.email = identity.email
        registration.idToken = idToken
        vault.keep(registration)
        vault.session = Vault.Session(
            clientID: grant.clientID, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
            scope: tokens.scope ?? "", expiresAt: now().addingTimeInterval(tokens.expiresIn ?? Self.documentedLifetime))
        vault.ended = nil
        store.save(vault)
        return nil
    }

    /// The access token for a request on the user's plan, refreshed first when it is about to expire.
    func bearer() async -> Result<String, AccountProblem> {
        guard let session = vault.session else { return .failure(.signedOut) }
        guard session.allowsPlanUsage else { return .failure(.planUsageOff) }
        return await freshSession().map(\.accessToken)
    }

    /// Refreshes the session when its access token is about to expire, so a session that OpenAI
    /// has ended shows as ended. Returns why it could not, or nil.
    func renewIfDue() async -> AccountProblem? {
        guard vault.session != nil else { return nil }
        if case .failure(let problem) = await freshSession() { return problem }
        return nil
    }

    /// Ends the session on this phone at once, then asks OpenAI to revoke its refresh token. Keeps
    /// the registration, so the next sign-in reuses its client ID. Returns whether OpenAI confirmed.
    func signOut() async -> Bool {
        guard let session = vault.session else { return true }
        vault.session = nil
        vault.ended = nil
        // OpenAI's docs: leave the ID token hint out of the sign-in after a sign-out.
        if var registration = vault.registration(session.clientID) {
            registration.idToken = nil
            vault.keep(registration)
        }
        store.save(vault)
        guard let refreshToken = session.refreshToken else { return true }
        let request = URLRequest.form(OpenAI.revoke, [
            "token": refreshToken, "token_type_hint": "refresh_token", "client_id": session.clientID,
        ])
        var waits = Self.revokeRetryWaits[...]
        while true {
            let reply = try? await transport.send(request)
            if reply?.status == 200 { return true }
            let worthRetrying = reply.map { $0.status >= 500 } ?? true
            guard worthRetrying, let wait = waits.popFirst() else { return false }
            await sleep(wait)
        }
    }

    /// Every refresh rotates the refresh token, and the old one stops working. Two refreshes at once
    /// would leave one of them holding a dead token, so every caller waits for the same request.
    private func freshSession() async -> Result<Vault.Session, AccountProblem> {
        if let refresh { return await refresh.value }
        guard let session = vault.session else { return .failure(.signedOut) }
        guard session.expiresAt.timeIntervalSince(now()) < Self.refreshMargin else { return .success(session) }
        let request = Task { await self.refreshed(session) }
        refresh = request
        defer { refresh = nil }
        return await request.value
    }

    private func refreshed(_ session: Vault.Session) async -> Result<Vault.Session, AccountProblem> {
        guard let refreshToken = session.refreshToken else { return .failure(end(.lapsed)) }
        let answer = await tokenAnswer(.form(OpenAI.token, [
            "grant_type": "refresh_token", "client_id": session.clientID, "refresh_token": refreshToken,
            "resource": OpenAI.resource,
        ]))
        // A sign-out or a new sign-in while the request was out must not be undone by a late answer.
        guard vault.session == session else { return .failure(.signedOut) }
        switch answer {
        case .tokens(let tokens):
            var renewed = session
            renewed.accessToken = tokens.accessToken
            renewed.refreshToken = tokens.refreshToken ?? refreshToken
            renewed.scope = tokens.scope ?? session.scope
            renewed.expiresAt = now().addingTimeInterval(tokens.expiresIn ?? Self.documentedLifetime)
            renewed.renewedAt = now()
            vault.session = renewed
            store.save(vault)
            return .success(renewed)
        case .unusableGrant: return .failure(end(.lapsed))
        case .invalidClient: return .failure(end(.clientRefused))
        case .rejected(let code): return .failure(.refused(code))
        case .unavailable: return .failure(.unreachable)
        }
    }

    /// Clears a session that OpenAI will not renew. The registration stays for the next sign-in,
    /// unless OpenAI no longer accepts its client ID.
    private func end(_ reason: SessionEnd) -> AccountProblem {
        if reason == .clientRefused, let clientID = vault.session?.clientID {
            vault.registrations.removeAll { $0.clientID == clientID }
        }
        vault.session = nil
        vault.ended = reason
        store.save(vault)
        return .signInAgain(reason)
    }

    private func tokenAnswer(_ request: URLRequest) async -> TokenAnswer {
        guard let reply = try? await transport.send(request) else { return .unavailable }
        return TokenAnswer(status: reply.status, body: reply.body)
    }
}
