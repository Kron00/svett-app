import Foundation

/// The addresses and fixed values of OpenAI's "Sign in with ChatGPT" flow for open-source apps. The
/// addresses are the ones in OpenAI's discovery document,
/// https://auth.openai.com/.well-known/openid-configuration.
enum OpenAI {
    static let issuer = "https://auth.openai.com"
    static let authorize = URL(string: "https://auth.openai.com/api/accounts/authorize")!
    static let token = URL(string: "https://auth.openai.com/api/accounts/oauth/token")!
    static let revoke = URL(string: "https://auth.openai.com/api/accounts/oauth/revoke")!
    static let keys = URL(string: "https://auth.openai.com/.well-known/jwks.json")!
    static let resource = "https://api.openai.com/v1"

    static let scope = "openid profile email offline_access resource.invoke \(planUsageScope)"
    /// A sign-in may spend the plan only when the granted scope has this.
    static let planUsageScope = "chatgpt.tokens.use.direct"
    /// The client id of a first sign-in. The server answers with an id of its own, and that one is kept.
    static let unregisteredClient = "dynamic_agent_client"
    static let agentName = "svett"
}

/// The network, as much of it as the sign-in uses. Tests and the stand-in launch mode put
/// `StubOpenAI` here, so they never reach OpenAI.
protocol OpenAITransport: Sendable {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

struct URLSessionTransport: OpenAITransport {
    private let session = URLSession(configuration: .ephemeral)

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let (body, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, body)
    }
}

extension URLRequest {
    /// A POST of `fields` in the form encoding the token endpoints take.
    static func form(_ url: URL, _ fields: KeyValuePairs<String, String>) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(OpenAI.query(fields).utf8)
        return request
    }
}

extension OpenAI {
    /// `fields` as a query string with everything outside the unreserved set escaped, so that a
    /// redirect address or a scope list survives as one value.
    static func query(_ fields: KeyValuePairs<String, String>) -> String {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        func escaped(_ text: String) -> String { text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "" }
        return fields.map { "\(escaped($0.key))=\(escaped($0.value))" }.joined(separator: "&")
    }

    /// The error code in an answer. The token endpoint sends `{"error": "invalid_grant"}`, and the
    /// API sends `{"error": {"code": ...}}`.
    static func errorCode(in body: Data) -> String? {
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
        if let plain = object["error"] as? String { return plain }
        if let nested = object["error"] as? [String: Any] { return nested["code"] as? String }
        return object["code"] as? String
    }
}
