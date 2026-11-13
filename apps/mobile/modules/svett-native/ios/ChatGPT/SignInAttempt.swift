import CryptoKit
import Foundation

/// One try at signing in. Its random values are checked when the browser comes back, so an address
/// from any other try is turned away.
struct SignInAttempt: Equatable, Sendable {
    let verifier: String
    let state: String
    let nonce: String
    let redirectURI: String
    /// The id that an earlier sign-in was given. Nil registers this install as a new client.
    let clientID: String?

    static let callbackPath = "/auth/callback"

    init(port: UInt16, clientID: String?, random: () -> String = SignInAttempt.randomValue) {
        verifier = random()
        state = random()
        nonce = random()
        // OpenAI accepts this address only. The port is the one part that may vary.
        redirectURI = "http://127.0.0.1:\(port)\(Self.callbackPath)"
        self.clientID = clientID
    }

    static func randomValue() -> String {
        Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64URLEncoded
    }

    var challenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
    }

    /// The page to open in the browser. `askAgain` makes ChatGPT show its consent page once more, for
    /// an account that declined plan usage before.
    func authorizeURL(hostID: UUID, askAgain: Bool) -> URL {
        var fields: [(String, String)] = [("client_id", clientID ?? OpenAI.unregisteredClient)]
        if clientID == nil { fields.append(("agent_name_hint", OpenAI.agentName)) }
        fields += [
            ("ext_agent_host_id", "urn:uuid:\(hostID.uuidString.lowercased())"),
            ("response_type", "code"),
            ("redirect_uri", redirectURI),
            ("scope", OpenAI.scope),
            ("resource", OpenAI.resource),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
        ]
        if askAgain { fields.append(("prompt", "consent")) }
        var parts = URLComponents(url: OpenAI.authorize, resolvingAgainstBaseURL: false)!
        parts.percentEncodedQuery = fields.map { OpenAI.query([$0.0: $0.1]) }.joined(separator: "&")
        return parts.url!
    }

    /// Reads the address the browser was sent back to. It may be the whole address, as pasted from
    /// Safari, or only the path and query, as the loopback listener receives it.
    func grant(from callback: String) throws(SignInProblem) -> SignInGrant {
        let text = callback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: text), parts.path == Self.callbackPath,
              let items = parts.queryItems else { throw .notTheAddress }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw .otherAttempt }
        if let error = value("error") { throw error == "access_denied" ? .denied : .refused }
        guard let code = value("code"), !code.isEmpty else { throw .notTheAddress }
        let issued = value("client_id").flatMap { $0 == OpenAI.unregisteredClient || $0.isEmpty ? nil : $0 }
        guard let clientID = issued ?? clientID else { throw .refused }
        return SignInGrant(code: code, clientID: clientID)
    }

    func exchange(_ grant: SignInGrant) -> URLRequest {
        .form(OpenAI.token, [
            "grant_type": "authorization_code",
            "client_id": grant.clientID,
            "code": grant.code,
            "code_verifier": verifier,
            "redirect_uri": redirectURI,
            "resource": OpenAI.resource,
        ])
    }
}

/// What a finished visit to the sign-in page hands back: the code to exchange, and the client id the
/// server issued for this install.
struct SignInGrant: Equatable, Sendable {
    let code: String
    let clientID: String
}

enum SignInProblem: Error, Equatable, Sendable {
    case notTheAddress
    case otherAttempt
    case denied
    case refused
    case unreachable
    case timedOut

    var message: String {
        switch self {
        case .notTheAddress: "That is not the sign-in address. Copy the whole address that starts with http://127.0.0.1 and paste it again."
        case .otherAttempt: "That address is from an earlier sign-in. Start the sign-in again."
        case .denied: "ChatGPT did not give this app access. Sign in again to allow it."
        case .refused: "ChatGPT did not finish the sign-in. Try again."
        case .unreachable: "Could not reach OpenAI. Check your connection and try again."
        case .timedOut: "The sign-in was not finished in time. Try again."
        }
    }
}

struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expiresIn: TimeInterval?
    let scope: String?

    init?(body: Data) {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let response = try? decoder.decode(TokenResponse.self, from: body) else { return nil }
        self = response
    }
}

/// The two claims the app reads from an ID token. The signature is not checked: the token comes
/// straight from the token endpoint over TLS, which OpenID Connect accepts in place of that check.
/// The nonce ties the token to the attempt that asked for it.
struct IDTokenClaims: Decodable {
    let nonce: String?
    let email: String?

    init?(idToken: String) {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let payload = Data(base64URLEncoded: String(parts[1])),
              let claims = try? JSONDecoder().decode(IDTokenClaims.self, from: payload) else { return nil }
        self = claims
    }
}

extension Data {
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64URLEncoded text: String) {
        var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        self.init(base64Encoded: padded)
    }
}
