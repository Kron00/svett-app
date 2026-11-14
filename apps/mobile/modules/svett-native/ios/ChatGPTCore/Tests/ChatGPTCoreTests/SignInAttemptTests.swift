import CryptoKit
import Foundation
import Testing
@testable import ChatGPTCore

struct SignInAttemptTests {
    let hostID = UUID(uuidString: "6A2F41A3-C54C-4C3B-9E1A-1F4D2B3C4D5E")!
    let saved = Vault.Registration(clientID: "oaiapp_mine", subject: "user-1", email: "you@example.com", idToken: "id.token.hint")

    func attempt(_ registration: Vault.Registration? = nil, askAgain: Bool = false) -> SignInAttempt {
        var values = ["verifier", "state-1", "nonce-1"].makeIterator()
        return SignInAttempt(port: 54321, registration: registration, askAgain: askAgain) { values.next()! }
    }

    func page(_ attempt: SignInAttempt) -> [String: String] {
        query(URLComponents(url: attempt.authorizeURL(hostID: hostID), resolvingAgainstBaseURL: false)?.queryItems)
    }

    @Test func aFirstSignInRegistersThisInstall() {
        let page = page(attempt())
        #expect(page == [
            "client_id": "dynamic_agent_client",
            "agent_name_hint": "svett",
            "ext_agent_host_id": "urn:uuid:6a2f41a3-c54c-4c3b-9e1a-1f4d2b3c4d5e",
            "response_type": "code",
            "redirect_uri": "http://127.0.0.1:54321/auth/callback",
            "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            "resource": "https://api.openai.com/v1",
            "state": "state-1",
            "nonce": "nonce-1",
            "code_challenge_method": "S256",
            "code_challenge": Data(SHA256.hash(data: Data("verifier".utf8))).base64URLEncoded,
        ])
    }

    @Test func aReturningSignInReusesTheIssuedClientIDWithHints() {
        let page = page(attempt(saved))
        #expect(page["client_id"] == "oaiapp_mine")
        #expect(page["agent_name_hint"] == nil)
        #expect(page["id_token_hint"] == "id.token.hint")
        #expect(page["login_hint"] == "you@example.com")
        #expect(page["prompt"] == nil)
    }

    @Test func askingAgainShowsTheConsentPage() {
        #expect(page(attempt(saved, askAgain: true))["prompt"] == "consent")
    }

    @Test func aNewRegistrationTakesTheIssuedClientID() {
        let grant = attempt().grant(from: "/auth/callback?code=c1&state=state-1&client_id=oaiapp_new&scope=openid")
        #expect(grant == .success(SignInGrant(code: "c1", clientID: "oaiapp_new")))
    }

    @Test func aNewRegistrationWithoutAnIssuedClientIDIsIncomplete() {
        #expect(attempt().grant(from: "/auth/callback?code=c1&state=state-1") == .failure(.incompleteRegistration))
        let unregistered = "/auth/callback?code=c1&state=state-1&client_id=dynamic_agent_client"
        #expect(attempt().grant(from: unregistered) == .failure(.incompleteRegistration))
    }

    @Test func aReturningSignInKeepsItsClientIDWhenTheCallbackLeavesItOut() {
        #expect(attempt(saved).grant(from: "/auth/callback?code=c1&state=state-1")
            == .success(SignInGrant(code: "c1", clientID: "oaiapp_mine")))
    }

    @Test func aReturningSignInRefusesAnotherClientID() {
        #expect(attempt(saved).grant(from: "/auth/callback?code=c1&state=state-1&client_id=oaiapp_other")
            == .failure(.otherClient))
    }

    @Test func checksTheStateBeforeReadingAnError() {
        #expect(attempt().grant(from: "/auth/callback?error=access_denied&state=state-2") == .failure(.otherAttempt))
        #expect(attempt().grant(from: "/auth/callback?error=access_denied&state=state-1") == .failure(.denied))
        #expect(attempt().grant(from: "/auth/callback?error=server_error&state=state-1") == .failure(.refused))
    }

    @Test func readsAWholeAddressPastedFromSafari() {
        let pasted = "  http://127.0.0.1:54321/auth/callback?code=c1&state=state-1&client_id=oaiapp_new\n"
        #expect(attempt().grant(from: pasted) == .success(SignInGrant(code: "c1", clientID: "oaiapp_new")))
    }

    @Test func turnsAwayAnythingElse() {
        #expect(attempt().grant(from: "https://example.com/") == .failure(.notTheAddress))
        #expect(attempt().grant(from: "/auth/callback?state=state-1") == .failure(.notTheAddress))
        #expect(attempt().grant(from: "/favicon.ico") == .failure(.notTheAddress))
    }

    @Test func exchangesTheCodeWithTheDocumentedFields() {
        let attempt = attempt()
        let request = attempt.exchange(SignInGrant(code: "c1", clientID: "oaiapp_new"))
        #expect(request.url == OpenAI.token)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
        #expect(fields(request) == [
            "grant_type": "authorization_code",
            "client_id": "oaiapp_new",
            "code": "c1",
            "code_verifier": "verifier",
            "redirect_uri": "http://127.0.0.1:54321/auth/callback",
            "resource": "https://api.openai.com/v1",
        ])
    }

    @Test func namesEachProblemForJavaScript() {
        #expect(SignInProblem.identity(.badSignature).code == "identity.badSignature")
        #expect(SignInProblem.codeExpired.code == "codeExpired")
    }

    @Test func aPastedAddressForThisAttemptIsTakenAndClearedFromThePasteboard() {
        let text = " http://127.0.0.1:54321/auth/callback?code=c1&state=state-1&client_id=oaiapp_new\n"
        let pasteboard = TestPasteboard(text)
        #expect(attempt().answer(on: pasteboard) == .success(text))
        #expect(pasteboard.text == nil)
    }

    @Test func aPastedAddressFromAnotherAttemptIsRefusedAndLeftOnThePasteboard() {
        let text = "http://127.0.0.1:54321/auth/callback?code=c1&state=state-0&client_id=oaiapp_new"
        let pasteboard = TestPasteboard(text)
        #expect(attempt().answer(on: pasteboard) == .failure(.otherAttempt))
        #expect(pasteboard.text == text)
    }

    @Test func pastedTextThatIsNotTheAddressIsRefused() {
        let pasteboard = TestPasteboard("https://chatgpt.com/")
        #expect(attempt().answer(on: pasteboard) == .failure(.notTheAddress))
        #expect(pasteboard.text == "https://chatgpt.com/")
    }

    @Test(arguments: [nil, "", " \n"] as [String?])
    func anEmptyPasteboardIsReported(text: String?) {
        #expect(attempt().answer(on: TestPasteboard(text)) == .failure(.nothingPasted))
    }
}
