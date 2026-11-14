import Foundation
import Security

/// Stands in for OpenAI's token, revocation and key endpoints, from memory. Tests script its
/// answers, and the `-svettChatGPTStub` launch argument runs the app against it, so neither
/// reaches OpenAI. Its ID tokens are signed with a key it makes for itself and publishes in its
/// key set, so they pass the same checks as OpenAI's.
final class StubOpenAI: OpenAITransport, @unchecked Sendable {
    enum Endpoint: Hashable, Sendable {
        case exchange
        case refresh
        case revoke
        case keys
    }

    /// An answer to script ahead of the default one.
    enum Answer: Sendable {
        case reply(Int, String)
        /// No answer at all, as with no network.
        case offline
    }

    /// What goes into the ID tokens it signs. Each field can be spoiled to test a check.
    struct Identity: Sendable {
        var subject = "user-stub"
        var email: String? = "you@example.com"
        var issuer = OpenAI.issuer
        /// The audience, when it should not be the client ID that was exchanged.
        var audience: String?
        /// Seconds from the clock's now until the token expires.
        var lifetime: TimeInterval = 3600
        /// Signs with a key that is not in the published key set.
        var signedByStranger = false
    }

    /// The client ID it issues to a new registration.
    static let issuedClientID = "oaiapp_stub"

    var identity: Identity {
        get { lock.withLock { identityValue } }
        set { lock.withLock { identityValue = newValue } }
    }

    /// Every request it was sent, in order.
    var requests: [URLRequest] { lock.withLock { sent } }

    /// The default answer's granted scope.
    let grantedScope: String
    private let lock = NSLock()
    private let now: @Sendable () -> Date
    /// Made once, because making an RSA key takes a moment. The stranger's key has the same key ID.
    static let signer = StubSigner(kid: "stub-key")
    static let stranger = StubSigner(kid: "stub-key")
    private var identityValue = Identity()
    private var scripted: [Endpoint: [Answer]] = [:]
    private var sent: [URLRequest] = []
    private var issued = 0

    init(grantedScope: String = OpenAI.scope, now: @escaping @Sendable () -> Date = { .now }) {
        self.grantedScope = grantedScope
        self.now = now
    }

    /// Queues `answers` for `endpoint`, ahead of its default answer.
    func script(_ endpoint: Endpoint, _ answers: Answer...) {
        lock.withLock { scripted[endpoint, default: []] += answers }
    }

    /// Stands in for ChatGPT's sign-in page: an address that goes straight back to the app, as the
    /// real page does once the user has approved. The code carries the nonce, so that the token
    /// endpoint can answer with an ID token that matches the attempt.
    static func signInPage(_ authorize: URL) -> URL {
        let asked = URLComponents(url: authorize, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { asked.first { $0.name == name }?.value }
        var page = URLComponents(string: value("redirect_uri") ?? "") ?? URLComponents()
        page.queryItems = [
            URLQueryItem(name: "code", value: code(nonce: value("nonce") ?? "")),
            URLQueryItem(name: "state", value: value("state")),
        ] + (value("client_id") == OpenAI.unregisteredClient
            ? [URLQueryItem(name: "client_id", value: issuedClientID)] : [])
        return page.url ?? authorize
    }

    /// The code the stand-in's sign-in page hands back for an attempt with `nonce`.
    static func code(nonce: String) -> String { "stub." + nonce }

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let form = Self.form(of: request)
        let endpoint: Endpoint? = switch request.url {
        case OpenAI.token: form["grant_type"] == "refresh_token" ? .refresh : .exchange
        case OpenAI.revoke: .revoke
        case OpenAI.keys: .keys
        default: nil
        }
        let next: Answer? = lock.withLock {
            sent.append(request)
            guard let endpoint, var queue = scripted[endpoint], !queue.isEmpty else { return nil }
            let answer = queue.removeFirst()
            scripted[endpoint] = queue
            return answer
        }
        switch next {
        case .reply(let status, let body): return (status, Data(body.utf8))
        case .offline: throw URLError(.notConnectedToInternet)
        case nil: break
        }
        switch endpoint {
        case .exchange: return (200, tokens(clientID: form["client_id"] ?? "", code: form["code"] ?? ""))
        case .refresh: return (200, tokens(clientID: form["client_id"] ?? "", code: nil))
        case .revoke: return (200, Data())
        case .keys: return (200, (try? JSONEncoder().encode(Self.signer.keySet)) ?? Data())
        case nil: return (404, Data())
        }
    }

    private func tokens(clientID: String, code: String?) -> Data {
        let (number, identity) = lock.withLock {
            issued += 1
            return (issued, identityValue)
        }
        var answer: [String: Any] = [
            "access_token": "stub-access-\(number)", "refresh_token": "stub-refresh-\(number)",
            "token_type": "Bearer", "expires_in": 3600, "scope": grantedScope,
        ]
        if let code, code.hasPrefix("stub.") {
            let issuedAt = now().timeIntervalSince1970
            var claims: [String: Any] = [
                "iss": identity.issuer, "sub": identity.subject, "aud": [identity.audience ?? clientID],
                "nonce": String(code.dropFirst(5)), "iat": issuedAt, "exp": issuedAt + identity.lifetime,
            ]
            if let email = identity.email { claims["email"] = email }
            answer["id_token"] = (identity.signedByStranger ? Self.stranger : Self.signer).token(claims)
        }
        return (try? JSONSerialization.data(withJSONObject: answer)) ?? Data()
    }

    private static func form(of request: URLRequest) -> [String: String] {
        let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
        let items = URLComponents(string: "?" + body)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
    }
}

/// An RSA key pair made on the spot, with its public half as a published key set.
struct StubSigner {
    let keySet: KeySet
    private let kid: String
    private let privateKey: SecKey

    init(kid: String) {
        let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048]
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, nil),
              let publicKey = SecKeyCopyPublicKey(privateKey),
              let der = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
              let parts = RSAPublicKeyDER.decode([UInt8](der))
        else { fatalError("The stand-in for OpenAI could not make an RSA key") }
        self.kid = kid
        self.privateKey = privateKey
        keySet = KeySet(keys: [SigningKey(
            kty: "RSA", kid: kid, alg: "RS256", use: "sig",
            n: Data(parts.modulus).base64URLEncoded, e: Data(parts.exponent).base64URLEncoded)])
    }

    func token(_ claims: [String: Any], algorithm: String = "RS256") -> String {
        let header: [String: Any] = ["alg": algorithm, "typ": "JWT", "kid": kid]
        func part(_ object: [String: Any]) -> String {
            ((try? JSONSerialization.data(withJSONObject: object)) ?? Data()).base64URLEncoded
        }
        let signed = "\(part(header)).\(part(claims))"
        let signature = SecKeyCreateSignature(
            privateKey, .rsaSignatureMessagePKCS1v15SHA256, Data(signed.utf8) as CFData, nil) as Data?
        return "\(signed).\((signature ?? Data()).base64URLEncoded)"
    }
}
