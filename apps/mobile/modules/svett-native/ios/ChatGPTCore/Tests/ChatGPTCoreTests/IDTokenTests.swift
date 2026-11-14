import Foundation
import Testing
@testable import ChatGPTCore

struct IDTokenTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let keys = StubOpenAI.signer.keySet
    static let unpublished = StubSigner(kid: "unpublished-key")

    func claims(_ changes: [String: Any?] = [:]) -> [String: Any] {
        var claims: [String: Any] = [
            "iss": OpenAI.issuer, "sub": "user-1", "aud": ["oaiapp_mine"], "nonce": "nonce-1",
            "iat": now.timeIntervalSince1970, "exp": now.timeIntervalSince1970 + 3600, "email": "you@example.com",
        ]
        for (key, value) in changes { claims[key] = value }
        return claims
    }

    func verify(_ token: String) -> Result<VerifiedIdentity, IDTokenProblem> {
        IDToken.verify(token, keys: keys, clientID: "oaiapp_mine", nonce: "nonce-1", now: now)
    }

    @Test func acceptsATokenThatPassesEveryCheck() {
        let token = StubOpenAI.signer.token(claims())
        #expect(verify(token) == .success(VerifiedIdentity(subject: "user-1", email: "you@example.com")))
    }

    @Test func acceptsAnAudienceGivenAsOneString() {
        #expect(verify(StubOpenAI.signer.token(claims(["aud": "oaiapp_mine"]))).map(\.subject) == .success("user-1"))
    }

    @Test func refusesABadSignature() {
        #expect(verify(StubOpenAI.stranger.token(claims())) == .failure(.badSignature))
    }

    @Test func refusesClaimsChangedAfterSigning() {
        let signed = StubOpenAI.signer.token(claims()).split(separator: ".").map(String.init)
        let forged = StubOpenAI.signer.token(claims(["sub": "someone-else"])).split(separator: ".").map(String.init)
        #expect(verify([signed[0], forged[1], signed[2]].joined(separator: ".")) == .failure(.badSignature))
    }

    @Test func refusesAKeyOpenAIDoesNotPublish() {
        #expect(verify(Self.unpublished.token(claims())) == .failure(.unknownKey))
    }

    @Test func refusesAnyAlgorithmButRS256() {
        #expect(verify(StubOpenAI.signer.token(claims(), algorithm: "HS256")) == .failure(.unsupportedAlgorithm))
        #expect(verify(StubOpenAI.signer.token(claims(), algorithm: "none")) == .failure(.unsupportedAlgorithm))
    }

    @Test func refusesAWrongAudience() {
        #expect(verify(StubOpenAI.signer.token(claims(["aud": ["oaiapp_another_app"]]))) == .failure(.wrongAudience))
        #expect(verify(StubOpenAI.signer.token(claims(["aud": nil]))) == .failure(.wrongAudience))
        #expect(verify(StubOpenAI.signer.token(claims(["azp": "oaiapp_another_app"]))) == .failure(.wrongAudience))
    }

    @Test func refusesAPastExpiryBeyondFiveSecondsOfClockDifference() {
        let justExpired = claims(["exp": now.timeIntervalSince1970 - 4])
        #expect(verify(StubOpenAI.signer.token(justExpired)).map(\.subject) == .success("user-1"))
        #expect(verify(StubOpenAI.signer.token(claims(["exp": now.timeIntervalSince1970 - 6]))) == .failure(.expired))
    }

    @Test func refusesAnotherIssuer() {
        #expect(verify(StubOpenAI.signer.token(claims(["iss": "https://auth.example.com"]))) == .failure(.wrongIssuer))
        #expect(verify(StubOpenAI.signer.token(claims(["iss": nil]))) == .failure(.wrongIssuer))
    }

    @Test func refusesAnotherAttemptsNonce() {
        #expect(verify(StubOpenAI.signer.token(claims(["nonce": "nonce-2"]))) == .failure(.wrongNonce))
        #expect(verify(StubOpenAI.signer.token(claims(["nonce": nil]))) == .failure(.wrongNonce))
    }

    @Test func refusesATokenWithoutSubjectExpiryOrIssueTime() {
        #expect(verify(StubOpenAI.signer.token(claims(["sub": nil]))) == .failure(.missingClaim))
        #expect(verify(StubOpenAI.signer.token(claims(["sub": ""]))) == .failure(.missingClaim))
        #expect(verify(StubOpenAI.signer.token(claims(["exp": nil]))) == .failure(.missingClaim))
        #expect(verify(StubOpenAI.signer.token(claims(["iat": nil]))) == .failure(.missingClaim))
    }

    @Test func refusesSomethingThatIsNotAToken() {
        #expect(verify("not a token") == .failure(.malformed))
        #expect(verify("a.b") == .failure(.malformed))
        #expect(verify("e30.e30.%%%") == .failure(.malformed))
    }

    @Test func readsTheKeySetOpenAIPublishes() throws {
        let published = #"{"keys": [{"kty": "RSA", "kid": "k1", "use": "sig", "alg": "RS256", "n": "\#(keys.keys[0].n ?? "")", "e": "AQAB", "x5c": ["ignored"]}]}"#
        let set = try #require(KeySet(body: Data(published.utf8)))
        #expect(set.keys.map(\.kid) == ["k1"])
        #expect(set.keys[0].publicKey != nil)
    }
}

struct RSAPublicKeyDERTests {
    @Test func readsBackWhatItWrites() throws {
        let modulus: [UInt8] = [0xC1] + Array(repeating: 0x5A, count: 255)
        let der = RSAPublicKeyDER.encode(modulus: [0, 0] + modulus, exponent: [0x01, 0x00, 0x01])
        let parts = try #require(RSAPublicKeyDER.decode(der))
        #expect(parts.modulus == modulus)
        #expect(parts.exponent == [0x01, 0x00, 0x01])
    }

    @Test func turnsAPublishedKeyIntoOneSecurityAccepts() {
        #expect(StubOpenAI.signer.keySet.keys[0].publicKey != nil)
    }
}

struct TokenAnswerTests {
    func answer(_ status: Int, _ body: String) -> TokenAnswer {
        TokenAnswer(status: status, body: Data(body.utf8))
    }

    @Test(arguments: TokenAnswer.unusableGrantCodes.sorted(), [400, 401])
    func eachDocumentedUnusableTokenCodeEndsTheGrant(code: String, status: Int) {
        #expect(answer(status, #"{"error": "\#(code)", "error_description": "x"}"#) == .unusableGrant(code))
        #expect(answer(status, #"{"error": {"code": "\#(code)", "message": "x"}}"#) == .unusableGrant(code))
    }

    @Test func invalidClientIsItsOwnAnswer() {
        #expect(answer(401, #"{"error": "invalid_client"}"#) == .invalidClient)
    }

    @Test(arguments: [500, 502, 503, 504, 429, 408])
    func serverErrorsAndRateLimitsLeaveTheTokensAlone(status: Int) {
        #expect(answer(status, "") == .unavailable)
        #expect(answer(status, "<html>Bad gateway</html>") == .unavailable)
    }

    @Test func anUndocumentedRefusalKeepsItsCode() {
        #expect(answer(400, #"{"error": "invalid_request"}"#) == .rejected("invalid_request"))
        #expect(answer(403, #"{"detail": "Region not supported"}"#) == .rejected(nil))
    }

    @Test func readsTheTokens() throws {
        let body = #"{"access_token": "a", "refresh_token": "r", "id_token": "i", "token_type": "Bearer", "expires_in": 3600, "scope": "openid", "earliest_refresh_at": 1}"#
        guard case .tokens(let tokens) = answer(200, body) else {
            Issue.record("Not read as tokens")
            return
        }
        #expect(tokens.accessToken == "a")
        #expect(tokens.refreshToken == "r")
        #expect(tokens.idToken == "i")
        #expect(tokens.expiresIn == 3600)
        #expect(tokens.scope == "openid")
    }

    @Test func aSuccessItCannotReadLeavesTheTokensAlone() {
        #expect(answer(200, "{}") == .unavailable)
        #expect(answer(200, "") == .unavailable)
    }
}
