import Foundation

/// The addresses and fixed values of OpenAI's "Sign in with ChatGPT" flow for open-source apps.
enum OpenAI {
    static let authorize = URL(string: "https://auth.openai.com/api/accounts/authorize")!
    static let token = URL(string: "https://auth.openai.com/api/accounts/oauth/token")!
    static let resource = "https://api.openai.com/v1"

    static let scope = "openid profile email offline_access resource.invoke \(planUsageScope)"
    /// A sign-in may spend the plan only when the granted scope has this.
    static let planUsageScope = "chatgpt.tokens.use.direct"
    /// The client id of a first sign-in. The server answers with an id of its own, and that one is kept.
    static let unregisteredClient = "dynamic_agent_client"
    static let agentName = "svett"
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
}
