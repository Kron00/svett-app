import CryptoKit
import Foundation

/// Which sign-in the user asked for.
enum SignInChoice: String, Sendable {
    /// A saved account through its issued client ID, by default the one used last. A first sign-in
    /// registers this install.
    case returning
    /// A ChatGPT account this install has not signed in to, through a new registration.
    case anotherAccount
    /// The signed-in account again, with ChatGPT's consent page, for an account that declined plan usage.
    case allowPlanUsage
}

/// One try at signing in. Its random values are checked when the browser comes back, so an address
/// from any other try is turned away.
struct SignInAttempt: Equatable, Sendable {
    let verifier: String
    let state: String
    let nonce: String
    let redirectURI: String
    /// The registration this sign-in returns to. Nil registers this install as a new client.
    let registration: Vault.Registration?
    let askAgain: Bool

    static let callbackPath = "/auth/callback"

    init(port: UInt16, registration: Vault.Registration?, askAgain: Bool = false,
         random: () -> String = SignInAttempt.randomValue) {
        verifier = random()
        state = random()
        nonce = random()
        // OpenAI accepts this address only. The port is the one part that may vary.
        redirectURI = "http://127.0.0.1:\(port)\(Self.callbackPath)"
        self.registration = registration
        self.askAgain = askAgain
    }

    static func randomValue() -> String {
        Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64URLEncoded
    }

    var challenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
    }

    /// The page to open in the browser.
    func authorizeURL(hostID: UUID) -> URL {
        var fields: [(String, String)] = [("client_id", registration?.clientID ?? OpenAI.unregisteredClient)]
        if registration == nil { fields.append(("agent_name_hint", OpenAI.agentName)) }
        fields.append(("ext_agent_host_id", "urn:uuid:\(hostID.uuidString.lowercased())"))
        if let hint = registration?.idToken { fields.append(("id_token_hint", hint)) }
        if let email = registration?.email { fields.append(("login_hint", email)) }
        fields += [
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
    func grant(from callback: String) -> Result<SignInGrant, SignInProblem> {
        let text = callback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: text), parts.path == Self.callbackPath,
              let items = parts.queryItems else { return .failure(.notTheAddress) }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { return .failure(.otherAttempt) }
        if let error = value("error") { return .failure(error == "access_denied" ? .denied : .refused) }
        guard let code = value("code"), !code.isEmpty else { return .failure(.notTheAddress) }
        let issued = value("client_id").flatMap { $0.isEmpty ? nil : $0 }
        guard let registration else {
            // A new registration is complete only with the client ID the server issued.
            guard let issued, issued != OpenAI.unregisteredClient else { return .failure(.incompleteRegistration) }
            return .success(SignInGrant(code: code, clientID: issued))
        }
        // A returning sign-in may leave the client ID out. Another one is not this account's.
        guard issued == nil || issued == registration.clientID else { return .failure(.otherClient) }
        return .success(SignInGrant(code: code, clientID: registration.clientID))
    }

    /// Takes the address a Safari sign-in could not open from the pasteboard, when it answers this
    /// attempt. Swift reads it, so the address and its one-time code never reach JavaScript. A taken
    /// address is cleared from the pasteboard, because the code in it signs in once.
    func answer(on pasteboard: any AddressPasteboard) -> Result<String, SignInProblem> {
        guard let address = pasteboard.text, !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(.nothingPasted)
        }
        if case .failure(let problem) = grant(from: address), problem == .notTheAddress || problem == .otherAttempt {
            return .failure(problem)
        }
        pasteboard.clear()
        return .success(address)
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

/// Where the user copied the address Safari could not open. The app's is the system pasteboard.
protocol AddressPasteboard {
    var text: String? { get }
    func clear()
}

/// What a finished visit to the sign-in page hands back: the code to exchange, and the client id
/// it belongs to.
struct SignInGrant: Equatable, Sendable {
    let code: String
    let clientID: String
}

/// Why a sign-in did not finish. JavaScript gets `code` and words it for the user.
enum SignInProblem: Error, Equatable, Sendable {
    case notTheAddress
    case otherAttempt
    case denied
    case refused
    case unreachable
    case timedOut
    case busy
    case notRunning
    /// The code was refused as used or expired. The next sign-in starts afresh with the same client ID.
    case codeExpired
    case clientRefused
    case incompleteRegistration
    case otherClient
    /// The ID token's verified account is not the one this registration belongs to.
    case otherAccount
    case identity(IDTokenProblem)
    /// The pasteboard holds no text to finish a Safari sign-in with.
    case nothingPasted
    /// The saved account to return to is no longer saved.
    case unknownAccount
    /// The Keychain could not be read, so this install's saved sign-in is not known.
    case storage

    var code: String {
        switch self {
        case .notTheAddress: "notTheAddress"
        case .otherAttempt: "otherAttempt"
        case .denied: "denied"
        case .refused: "refused"
        case .unreachable: "unreachable"
        case .timedOut: "timedOut"
        case .busy: "busy"
        case .notRunning: "notRunning"
        case .codeExpired: "codeExpired"
        case .clientRefused: "clientRefused"
        case .incompleteRegistration: "incompleteRegistration"
        case .otherClient: "otherClient"
        case .otherAccount: "otherAccount"
        case .identity(let problem): "identity.\(problem.rawValue)"
        case .nothingPasted: "nothingPasted"
        case .unknownAccount: "unknownAccount"
        case .storage: "storage"
        }
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
