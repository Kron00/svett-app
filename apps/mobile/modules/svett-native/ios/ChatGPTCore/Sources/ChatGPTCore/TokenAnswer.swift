import Foundation

struct TokenResponse: Decodable, Equatable, Sendable {
    let accessToken: String
    /// Sent only when `offline_access` was granted.
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

/// What an answer from the token endpoint means, from its status and its error code. OpenAI's
/// "Errors and recovery" page names the codes. It gives no status for them, so a code counts
/// whatever the status.
enum TokenAnswer: Equatable, Sendable {
    case tokens(TokenResponse)
    /// The refresh token, or the code, can never be used again.
    case unusableGrant(String)
    /// OpenAI does not accept the issued client ID.
    case invalidClient
    /// Turned down for a reason OpenAI does not document. Nothing says the tokens are dead.
    case rejected(String?)
    /// No answer, a server error, a rate limit, or a body the app cannot read. The tokens may be fine.
    case unavailable

    static let unusableGrantCodes: Set = [
        "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
        "refresh_token_invalidated", "refresh_token_reused",
    ]

    init(status: Int, body: Data) {
        if status == 200 {
            self = TokenResponse(body: body).map(TokenAnswer.tokens) ?? .unavailable
            return
        }
        let code = OpenAI.errorCode(in: body)
        if let code, Self.unusableGrantCodes.contains(code) {
            self = .unusableGrant(code)
        } else if code == "invalid_client" {
            self = .invalidClient
        } else if status >= 500 || status == 408 || status == 429 || status == 0 {
            self = .unavailable
        } else {
            self = .rejected(code)
        }
    }
}
