import Foundation
@testable import ChatGPTCore

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)

    var now: Date { lock.withLock { value } }

    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}

/// Holds every refresh answer until `release`, so a test can act while a refresh is out.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false

    var waiters: Int { lock.withLock { waiting.count } }

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let go = lock.withLock { () -> Bool in
                if isOpen { return true }
                waiting.append(continuation)
                return false
            }
            if go { continuation.resume() }
        }
    }

    func release() {
        let held = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            defer { waiting = [] }
            return waiting
        }
        for continuation in held { continuation.resume() }
    }
}

struct HeldRefreshes: OpenAITransport {
    let stub: StubOpenAI
    let gate: Gate

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let answer = try await stub.send(request)
        if fields(request)["grant_type"] == "refresh_token" { await gate.wait() }
        return answer
    }
}

/// A vault in memory whose reads and writes a test can make fail, as a Keychain can.
final class FlakyStore: VaultStore, @unchecked Sendable {
    private let lock = NSLock()
    private var vault: Vault?
    private var failingReads = false
    private var failingWrites = false

    init(_ vault: Vault? = nil) {
        self.vault = vault
    }

    struct Refused: Error {}

    /// What the store holds, read past any failure.
    var saved: Vault? { lock.withLock { vault } }

    var failsReads: Bool {
        get { lock.withLock { failingReads } }
        set { lock.withLock { failingReads = newValue } }
    }

    var failsWrites: Bool {
        get { lock.withLock { failingWrites } }
        set { lock.withLock { failingWrites = newValue } }
    }

    func load() throws -> Vault? {
        try lock.withLock {
            if failingReads { throw Refused() }
            return vault
        }
    }

    func save(_ vault: Vault) throws {
        try lock.withLock {
            if failingWrites { throw Refused() }
            self.vault = vault
        }
    }
}

/// A pasteboard that holds one text.
final class TestPasteboard: AddressPasteboard {
    var text: String?

    init(_ text: String?) {
        self.text = text
    }

    func clear() { text = nil }
}

/// An account on the stand-in, with a clock the test moves.
final class Harness: @unchecked Sendable {
    let clock: TestClock
    let stub: StubOpenAI
    let store: FlakyStore
    let account: ChatGPTAccount

    init(vault: Vault? = nil, grantedScope: String = OpenAI.scope, gate: Gate? = nil) {
        let clock = TestClock()
        let stub = StubOpenAI(grantedScope: grantedScope, now: { clock.now })
        let store = FlakyStore(vault)
        let transport: any OpenAITransport = gate.map { HeldRefreshes(stub: stub, gate: $0) } ?? stub
        self.clock = clock
        self.stub = stub
        self.store = store
        account = ChatGPTAccount(transport: transport, store: store, now: { clock.now }, sleep: { _ in })
    }

    /// Signs in as the browser would: opens the attempt's page on the stand-in, follows it back to
    /// the callback address, and exchanges the code. A new registration gets the client ID `issuing`.
    func signIn(_ choice: SignInChoice = .returning, account saved: String? = nil,
                issuing: String = StubOpenAI.issuedClientID) async -> SignInProblem? {
        let begun: (attempt: SignInAttempt, page: URL)
        switch await account.beginSignIn(port: 1455, choice: choice, account: saved) {
        case .success(let started): begun = started
        case .failure(let problem): return problem
        }
        switch begun.attempt.grant(from: StubOpenAI.signInPage(begun.page, issuing: issuing).absoluteString) {
        case .success(let grant): return await account.finishSignIn(begun.attempt, grant)
        case .failure(let problem): return problem
        }
    }

    func requests(to endpoint: StubOpenAI.Endpoint) -> [URLRequest] {
        stub.requests.filter { request in
            switch endpoint {
            case .exchange: request.url == OpenAI.token && fields(request)["grant_type"] == "authorization_code"
            case .refresh: request.url == OpenAI.token && fields(request)["grant_type"] == "refresh_token"
            case .revoke: request.url == OpenAI.revoke
            case .keys: request.url == OpenAI.keys
            }
        }
    }

    /// The query of the page the next sign-in would open.
    func signInPage(_ choice: SignInChoice, account saved: String? = nil) async throws -> [String: String] {
        let page = try await account.beginSignIn(port: 1455, choice: choice, account: saved).get().page
        return query(URLComponents(url: page, resolvingAgainstBaseURL: false)?.queryItems)
    }
}

func fields(_ request: URLRequest) -> [String: String] {
    let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
    return query(URLComponents(string: "?" + body)?.queryItems)
}

func query(_ items: [URLQueryItem]?) -> [String: String] {
    Dictionary((items ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
}

/// Lets other tasks run until `condition` holds.
func eventually(_ condition: () -> Bool) async {
    for _ in 0..<10_000 where !condition() {
        await Task.yield()
    }
}

let savedYou = AccountStatus.SavedAccount(id: StubOpenAI.issuedClientID, email: "you@example.com")
