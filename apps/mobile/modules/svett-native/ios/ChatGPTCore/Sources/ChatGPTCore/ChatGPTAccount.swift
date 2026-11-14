import Foundation

/// What JavaScript may know of the account. It never carries a token.
enum AccountStatus: Equatable, Sendable {
    case signedIn(email: String?, scope: String, expiresAt: Date, renewedAt: Date?)
    /// `accounts` are the saved registrations, the one used last first.
    case signedOut(accounts: [SavedAccount], ended: SessionEnd?)

    /// A ChatGPT account this install has signed in to. `id` is its issued client ID, which OpenAI
    /// shows in the sign-in address and which is no credential. It stays the same for the life of
    /// the registration, so the settings screen can return to that account by it.
    struct SavedAccount: Equatable, Sendable {
        let id: String
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
        case let .signedOut(accounts, ended):
            let saved: [[String: Any]] = accounts.map { account in
                var entry: [String: Any] = ["id": account.id]
                if let email = account.email { entry["email"] = email }
                return entry
            }
            record = ["state": "signedOut", "accounts": saved]
            if let last = saved.first { record["returning"] = last.filter { $0.key == "email" } }
            if let ended { record["ended"] = ended.rawValue }
        }
        return record
    }
}

/// The status with whether the Keychain holds it. JavaScript reads both.
struct AccountSnapshot: Equatable, Sendable {
    let status: AccountStatus
    /// The Keychain could not be read, or refused the last write, so what it holds is not what
    /// svett uses.
    let unsaved: Bool

    var record: [String: Any] {
        var record = status.record
        if unsaved { record["unsaved"] = true }
        return record
    }
}

/// How a sign-out went, on the phone and at OpenAI.
struct SignOutResult: Equatable, Sendable {
    /// OpenAI confirmed it revoked the refresh token.
    let revoked: Bool
    /// The tokens are gone from the Keychain. When false, they are gone from memory only, and svett
    /// keeps trying to delete them while it runs.
    let cleared: Bool

    var record: [String: Any] { ["revoked": revoked, "cleared": cleared] }
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
    private var vault = Vault()
    /// Whether `vault` is the one in the store. Until the store has been read, nothing is written to
    /// it, so a Keychain that could not be read is never overwritten with an empty vault.
    private var loaded = false
    /// The store refused the last write. Memory holds the truth, and every call writes it again.
    private var unsaved = false
    /// OpenAI's published keys, kept between sign-ins.
    private var keys: KeySet?
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
        settle()
        if let session = vault.session {
            return .signedIn(email: vault.registration(session.clientID)?.email, scope: session.scope,
                             expiresAt: session.expiresAt, renewedAt: session.renewedAt)
        }
        let accounts = vault.registrations.reversed().map { AccountStatus.SavedAccount(id: $0.clientID, email: $0.email) }
        return .signedOut(accounts: accounts, ended: vault.ended)
    }

    var snapshot: AccountSnapshot {
        let current = self.status
        return AccountSnapshot(status: current, unsaved: storeBehind)
    }

    /// Starts a sign-in. `account` names a saved registration to return to, by its `SavedAccount.id`.
    /// A returning sign-in without one returns to the account used last.
    func beginSignIn(port: UInt16, choice: SignInChoice, account: String? = nil)
        -> Result<(attempt: SignInAttempt, page: URL), SignInProblem>
    {
        settle()
        // Without the stored vault, this install's host ID is not known, and OpenAI would take the
        // phone for a new host.
        guard loaded else { return .failure(.storage) }
        // A new install has just made its host id. It has to be the same one at the next sign-in.
        persist()
        let registration: Vault.Registration?
        switch choice {
        case .returning:
            if let account {
                guard let saved = vault.registration(account) else { return .failure(.unknownAccount) }
                registration = saved
            } else {
                registration = vault.registrations.last
            }
        case .anotherAccount: registration = nil
        case .allowPlanUsage:
            registration = vault.session.flatMap { vault.registration($0.clientID) } ?? vault.registrations.last
        }
        let attempt = SignInAttempt(port: port, registration: registration, askAgain: choice == .allowPlanUsage)
        return .success((attempt: attempt, page: attempt.authorizeURL(hostID: vault.hostID)))
    }

    /// Exchanges the code, checks the ID token, and keeps the tokens with their registration. A
    /// token that fails a check leaves the vault as it was.
    func finishSignIn(_ attempt: SignInAttempt, _ grant: SignInGrant) async -> SignInProblem? {
        settle()
        let tokens: TokenResponse
        switch await tokenAnswer(attempt.exchange(grant)) {
        case .tokens(let answer): tokens = answer
        case .unusableGrant:
            // OpenAI's cookbook: keep a newly issued client ID when its code fails, so the next try
            // does not register a second app.
            if vault.registration(grant.clientID) == nil {
                vault.keep(Vault.Registration(clientID: grant.clientID))
                persist()
            }
            return .codeExpired
        case .invalidClient:
            vault.registrations.removeAll { $0.clientID == grant.clientID }
            persist()
            return .clientRefused
        case .rejected: return .refused
        case .unavailable: return .unreachable
        }
        guard let idToken = tokens.idToken else { return .identity(.malformed) }
        let identity: VerifiedIdentity
        switch await verify(idToken, clientID: grant.clientID, nonce: attempt.nonce) {
        case .success(let verified): identity = verified
        case .failure(let problem): return problem
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
        persist()
        return nil
    }

    /// The access token for a request on the user's plan, refreshed first when it is about to expire.
    func bearer() async -> Result<String, AccountProblem> {
        settle()
        guard vault.session != nil else { return .failure(.signedOut) }
        // The scope is checked on the session being handed out, because a refresh can take plan
        // usage away.
        switch await freshSession() {
        case .success(let session): return session.allowsPlanUsage ? .success(session.accessToken) : .failure(.planUsageOff)
        case .failure(let problem): return .failure(problem)
        }
    }

    /// Refreshes the session when its access token is about to expire, so a session that OpenAI
    /// has ended shows as ended. Returns why it could not, or nil.
    func renewIfDue() async -> AccountProblem? {
        settle()
        guard vault.session != nil else { return nil }
        if case .failure(let problem) = await freshSession() { return problem }
        return nil
    }

    /// Ends the session on this phone at once, then asks OpenAI to revoke its refresh token. Keeps
    /// the registration, so the next sign-in reuses its client ID.
    func signOut() async -> SignOutResult {
        settle()
        guard let session = vault.session else { return SignOutResult(revoked: true, cleared: !storeBehind) }
        vault.session = nil
        vault.ended = nil
        // OpenAI's docs: leave the ID token hint out of the sign-in after a sign-out.
        if var registration = vault.registration(session.clientID) {
            registration.idToken = nil
            vault.keep(registration)
        }
        let cleared = persist()
        // Revoked tokens are worthless even when the Keychain kept them.
        let revoked = await revoke(session)
        return SignOutResult(revoked: revoked, cleared: cleared || persistIfUnsaved())
    }

    private func revoke(_ session: Vault.Session) async -> Bool {
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
            // The old refresh token is dead now. When the Keychain refuses the new one, memory keeps
            // it and every later call writes it again.
            vault.session = renewed
            persist()
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
        persist()
        return .signInAgain(reason)
    }

    /// Checks the ID token against OpenAI's keys. A token signed with a key the kept set lacks
    /// fetches the set once more, past any cache, because OpenAI may have rotated its keys since.
    private func verify(_ idToken: String, clientID: String, nonce: String) async -> Result<VerifiedIdentity, SignInProblem> {
        func check(_ keys: KeySet) -> Result<VerifiedIdentity, IDTokenProblem> {
            IDToken.verify(idToken, keys: keys, clientID: clientID, nonce: nonce, now: now())
        }
        let kept: KeySet
        if let keys {
            kept = keys
        } else {
            guard let fetched = await fetchKeys(revalidating: false) else { return .failure(.unreachable) }
            kept = fetched
            keys = fetched
        }
        let result = check(kept)
        if result != .failure(.unknownKey) { return result.mapError(SignInProblem.identity) }
        guard let fetched = await fetchKeys(revalidating: true) else { return .failure(.unreachable) }
        keys = fetched
        return check(fetched).mapError(SignInProblem.identity)
    }

    private func fetchKeys(revalidating: Bool) async -> KeySet? {
        var request = URLRequest(url: OpenAI.keys)
        if revalidating {
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }
        guard let reply = try? await transport.send(request), reply.status == 200 else { return nil }
        return KeySet(body: reply.body)
    }

    private func tokenAnswer(_ request: URLRequest) async -> TokenAnswer {
        guard let reply = try? await transport.send(request) else { return .unavailable }
        return TokenAnswer(status: reply.status, body: reply.body)
    }

    /// Reads the store the first time it is needed, and again on each call after a read that failed.
    /// Once it is read, writes again what the store refused before.
    private func settle() {
        guard loaded else {
            do {
                vault = try store.load() ?? Vault()
                loaded = true
                unsaved = false
            } catch {}
            return
        }
        persistIfUnsaved()
    }

    /// The store does not hold what svett uses: it could not be read, or it refused the last write.
    private var storeBehind: Bool { !loaded || unsaved }

    /// Writes the vault, and records whether the store took it.
    @discardableResult
    private func persist() -> Bool {
        guard loaded else {
            unsaved = true
            return false
        }
        do {
            try store.save(vault)
            unsaved = false
        } catch {
            unsaved = true
        }
        return !unsaved
    }

    @discardableResult
    private func persistIfUnsaved() -> Bool {
        unsaved ? persist() : true
    }
}
