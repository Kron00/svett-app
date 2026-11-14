import Foundation
import Testing
@testable import ChatGPTCore

struct SignInTests {
    @Test func aFirstSignInKeepsTheTokensWithTheVerifiedAccount() async throws {
        let harness = Harness()
        #expect(await harness.signIn() == nil)
        let vault = try #require(harness.store.saved)
        let registration = try #require(vault.registrations.first)
        #expect(vault.registrations.count == 1)
        #expect(registration.clientID == StubOpenAI.issuedClientID)
        #expect(registration.subject == "user-stub")
        #expect(registration.email == "you@example.com")
        #expect(registration.idToken?.split(separator: ".").count == 3)
        #expect(vault.session?.accessToken == "stub-access-1")
        #expect(vault.session?.refreshToken == "stub-refresh-1")
        #expect(await harness.account.status == .signedIn(
            email: "you@example.com", scope: OpenAI.scope, expiresAt: harness.clock.now + 3600, renewedAt: nil))
        #expect(harness.requests(to: .keys).count == 1)
    }

    @Test func whatJavaScriptReadsCarriesNoToken() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        let vault = try #require(harness.store.saved)
        let secrets = [vault.session?.accessToken, vault.session?.refreshToken, vault.registrations.first?.idToken]
        let record = try JSONSerialization.data(withJSONObject: await harness.account.status.record)
        let text = String(decoding: record, as: UTF8.self)
        for secret in secrets {
            let secret = try #require(secret)
            #expect(!text.contains(secret))
        }
        #expect(text.contains(#""planUsage":true"#))
    }

    @Test(arguments: [IDTokenProblem.badSignature, .wrongAudience, .expired, .wrongIssuer])
    func anIDTokenThatFailsACheckSavesNothing(problem: IDTokenProblem) async {
        let harness = Harness()
        switch problem {
        case .badSignature: harness.stub.identity.signedByStranger = true
        case .wrongAudience: harness.stub.identity.audience = "oaiapp_another_app"
        case .expired: harness.stub.identity.lifetime = -60
        case .wrongIssuer: harness.stub.identity.issuer = "https://auth.example.com"
        default: Issue.record("No way to spoil \(problem)")
        }
        #expect(await harness.signIn() == .identity(problem))
        #expect(harness.store.saved?.session == nil)
        #expect(harness.store.saved?.registrations == [])
        #expect(await harness.account.status == .signedOut(accounts: [], ended: nil))
    }

    @Test func anAnswerWithoutAnIDTokenSavesNothing() async {
        let harness = Harness()
        harness.stub.script(.exchange, .reply(200, #"{"access_token": "a", "refresh_token": "r", "expires_in": 3600}"#))
        #expect(await harness.signIn() == .identity(.malformed))
        #expect(harness.store.saved?.session == nil)
    }

    @Test func keysThatCannotBeFetchedSaveNothing() async {
        let harness = Harness()
        harness.stub.script(.keys, .offline)
        #expect(await harness.signIn() == .unreachable)
        #expect(harness.store.saved?.session == nil)
    }

    @Test func aRefusedCodeKeepsTheIssuedClientIDForTheNextTry() async throws {
        let harness = Harness()
        harness.stub.script(.exchange, .reply(400, #"{"error": "invalid_grant"}"#))
        #expect(await harness.signIn() == .codeExpired)
        #expect(harness.store.saved?.registrations == [Vault.Registration(clientID: StubOpenAI.issuedClientID)])
        #expect(harness.store.saved?.session == nil)
        let next = try await harness.signInPage(.returning)
        #expect(next["client_id"] == StubOpenAI.issuedClientID)
        #expect(next["agent_name_hint"] == nil)
        #expect(await harness.signIn() == nil)
        #expect(harness.store.saved?.registrations.map(\.subject) == ["user-stub"])
    }

    @Test func aRefusedClientForgetsTheRegistration() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        _ = await harness.account.signOut()
        harness.stub.script(.exchange, .reply(401, #"{"error": "invalid_client"}"#))
        #expect(await harness.signIn() == .clientRefused)
        #expect(harness.store.saved?.registrations == [])
        #expect(try await harness.signInPage(.returning)["client_id"] == OpenAI.unregisteredClient)
    }

    @Test(arguments: [StubOpenAI.Answer.reply(500, ""), .reply(503, "{}"), .reply(429, ""), .offline])
    func noAnswerFromTheTokenEndpointSavesNothing(answer: StubOpenAI.Answer) async {
        let harness = Harness()
        harness.stub.script(.exchange, answer)
        #expect(await harness.signIn() == .unreachable)
        #expect(harness.store.saved?.session == nil)
    }

    @Test func anUndocumentedRefusalOfTheCodeSavesNothing() async {
        let harness = Harness()
        harness.stub.script(.exchange, .reply(400, #"{"error": "invalid_request"}"#))
        #expect(await harness.signIn() == .refused)
        #expect(harness.store.saved?.session == nil)
    }

    @Test func aReturningSignInAsSomeoneElseIsRefused() async {
        let harness = Harness()
        _ = await harness.signIn()
        _ = await harness.account.signOut()
        harness.stub.identity.subject = "someone-else"
        #expect(await harness.signIn() == .otherAccount)
        #expect(harness.store.saved?.registrations.map(\.subject) == ["user-stub"])
        #expect(harness.store.saved?.session == nil)
    }

    @Test func allowingPlanUsageAsksAgainAsTheSignedInAccount() async throws {
        let harness = Harness(grantedScope: "openid profile email offline_access")
        _ = await harness.signIn()
        #expect(await harness.account.bearer() == .failure(.planUsageOff))
        let idToken = try #require(harness.store.saved?.registrations.first?.idToken)
        let page = try await harness.signInPage(.allowPlanUsage)
        #expect(page["client_id"] == StubOpenAI.issuedClientID)
        #expect(page["prompt"] == "consent")
        #expect(page["id_token_hint"] == idToken)
        #expect(page["login_hint"] == "you@example.com")
        #expect(page["scope"] == OpenAI.scope)
    }

    @Test func anotherAccountRegistersAgain() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        _ = await harness.account.signOut()
        let page = try await harness.signInPage(.anotherAccount)
        #expect(page["client_id"] == OpenAI.unregisteredClient)
        #expect(page["agent_name_hint"] == "svett")
        #expect(page["id_token_hint"] == nil)
        #expect(page["login_hint"] == nil)
    }

    @Test func theHostIDOutlivesEverySignOut() async throws {
        let harness = Harness()
        let first = try await harness.signInPage(.returning)["ext_agent_host_id"]
        _ = await harness.signIn()
        _ = await harness.account.signOut()
        #expect(try await harness.signInPage(.anotherAccount)["ext_agent_host_id"] == first)
        #expect(first?.hasPrefix("urn:uuid:") == true)
    }
}

struct RefreshTests {
    func signedIn(gate: Gate? = nil) async -> Harness {
        let harness = Harness(gate: gate)
        _ = await harness.signIn()
        return harness
    }

    @Test func aFreshTokenIsUsedAsItIs() async {
        let harness = await signedIn()
        harness.clock.advance(3600 - ChatGPTAccount.refreshMargin - 1)
        #expect(await harness.account.bearer() == .success("stub-access-1"))
        #expect(harness.requests(to: .refresh).isEmpty)
    }

    @Test func aTokenAboutToExpireIsRefreshedWithTheDocumentedFields() async throws {
        let harness = await signedIn()
        harness.clock.advance(3600 - 60)
        #expect(await harness.account.bearer() == .success("stub-access-2"))
        let request = try #require(harness.requests(to: .refresh).first)
        #expect(fields(request) == [
            "grant_type": "refresh_token",
            "client_id": StubOpenAI.issuedClientID,
            "refresh_token": "stub-refresh-1",
            "resource": "https://api.openai.com/v1",
        ])
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-2")
        #expect(await harness.account.status == .signedIn(
            email: "you@example.com", scope: OpenAI.scope, expiresAt: harness.clock.now + 3600,
            renewedAt: harness.clock.now))
    }

    @Test func theNextRefreshSendsTheReplacementToken() async {
        let harness = await signedIn()
        harness.clock.advance(3600)
        _ = await harness.account.bearer()
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .success("stub-access-3"))
        #expect(harness.requests(to: .refresh).map { fields($0)["refresh_token"] } == ["stub-refresh-1", "stub-refresh-2"])
    }

    @Test func callersAtTheSameTimeShareOneRefresh() async {
        let gate = Gate()
        let harness = await signedIn(gate: gate)
        harness.clock.advance(3600)
        let first = Task { await harness.account.bearer() }
        await eventually { gate.waiters == 1 }
        let second = Task { await harness.account.bearer() }
        let third = Task { await harness.account.renewIfDue() }
        for _ in 0..<100 { await Task.yield() }
        gate.release()
        #expect(await first.value == .success("stub-access-2"))
        #expect(await second.value == .success("stub-access-2"))
        #expect(await third.value == nil)
        #expect(harness.requests(to: .refresh).count == 1)
    }

    @Test(arguments: TokenAnswer.unusableGrantCodes.sorted())
    func eachUnusableRefreshTokenEndsTheSessionAndKeepsTheClientID(code: String) async throws {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(400, #"{"error": "\#(code)"}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .failure(.signInAgain(.lapsed)))
        #expect(await harness.account.status == .signedOut(accounts: [savedYou], ended: .lapsed))
        #expect(harness.store.saved?.session == nil)
        #expect(try await harness.signInPage(.returning)["client_id"] == StubOpenAI.issuedClientID)
    }

    @Test func aRefusedClientEndsTheSessionAndTheRegistration() async throws {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(401, #"{"error": "invalid_client"}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.renewIfDue() == .signInAgain(.clientRefused))
        #expect(await harness.account.status == .signedOut(accounts: [], ended: .clientRefused))
        #expect(try await harness.signInPage(.returning)["client_id"] == OpenAI.unregisteredClient)
    }

    @Test(arguments: [StubOpenAI.Answer.reply(500, ""), .reply(503, ""), .reply(429, ""), .reply(200, "{}"), .offline])
    func noUsableAnswerKeepsTheSessionForTheNextTry(answer: StubOpenAI.Answer) async {
        let harness = await signedIn()
        harness.stub.script(.refresh, answer)
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .failure(.unreachable))
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-1")
        #expect(await harness.account.bearer() == .success("stub-access-2"))
    }

    @Test func anUndocumentedRefusalKeepsTheSession() async {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(400, #"{"error": "invalid_request"}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.renewIfDue() == .refused("invalid_request"))
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-1")
    }

    @Test func aRefreshThatTakesAwayPlanUsageTurnsItOff() async {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(200, #"{"access_token": "a2", "refresh_token": "r2", "expires_in": 3600, "scope": "openid email"}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.renewIfDue() == nil)
        #expect(await harness.account.bearer() == .failure(.planUsageOff))
    }

    @Test func aRefreshThatTakesAwayPlanUsageNeverHandsOutItsToken() async {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(200, #"{"access_token": "a2", "refresh_token": "r2", "expires_in": 3600, "scope": "openid email"}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .failure(.planUsageOff))
        #expect(harness.requests(to: .refresh).count == 1)
        #expect(harness.store.saved?.session?.refreshToken == "r2")
    }

    @Test func aRefreshAnswerWithoutARefreshTokenKeepsTheOldOne() async {
        let harness = await signedIn()
        harness.stub.script(.refresh, .reply(200, #"{"access_token": "a2", "expires_in": 3600}"#))
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .success("a2"))
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-1")
        #expect(harness.store.saved?.session?.scope == OpenAI.scope)
    }

    @Test func aSignOutWhileARefreshIsOutIsNotUndone() async {
        let gate = Gate()
        let harness = await signedIn(gate: gate)
        harness.clock.advance(3600)
        let pending = Task { await harness.account.bearer() }
        await eventually { gate.waiters == 1 }
        #expect(await harness.account.signOut().revoked)
        gate.release()
        #expect(await pending.value == .failure(.signedOut))
        #expect(harness.store.saved?.session == nil)
        #expect(await harness.account.status == .signedOut(accounts: [savedYou], ended: nil))
    }

    @Test func aSessionWithoutARefreshTokenLapsesAtItsEnd() async {
        let vault = Vault(
            registrations: [Vault.Registration(clientID: "oaiapp_stub", subject: "user-stub")],
            session: Vault.Session(clientID: "oaiapp_stub", accessToken: "a", refreshToken: nil, scope: OpenAI.scope,
                                   expiresAt: Date(timeIntervalSince1970: 1_800_000_000)))
        let lapsing = Harness(vault: vault)
        #expect(await lapsing.account.bearer() == .failure(.signInAgain(.lapsed)))
        #expect(lapsing.requests(to: .refresh).isEmpty)
    }
}

struct SignOutTests {
    @Test func signingOutRevokesTheRefreshTokenAndKeepsTheClientID() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        #expect(await harness.account.signOut().revoked)
        let request = try #require(harness.requests(to: .revoke).first)
        #expect(request.httpMethod == "POST")
        #expect(fields(request) == [
            "token": "stub-refresh-1", "token_type_hint": "refresh_token", "client_id": StubOpenAI.issuedClientID,
        ])
        let vault = try #require(harness.store.saved)
        #expect(vault.session == nil)
        #expect(vault.registrations.map(\.clientID) == [StubOpenAI.issuedClientID])
        #expect(vault.registrations.first?.idToken == nil)
        #expect(await harness.account.status == .signedOut(accounts: [savedYou], ended: nil))
        #expect(await harness.account.bearer() == .failure(.signedOut))
    }

    @Test func aRevocationThatMeetsServerErrorsIsRetried() async {
        let harness = Harness()
        _ = await harness.signIn()
        harness.stub.script(.revoke, .reply(503, ""), .offline)
        #expect(await harness.account.signOut().revoked)
        #expect(harness.requests(to: .revoke).count == 3)
    }

    @Test func anUnconfirmedRevocationStillSignsOutOnThePhone() async {
        let harness = Harness()
        _ = await harness.signIn()
        harness.stub.script(.revoke, .offline, .reply(502, ""), .offline, .reply(200, ""))
        #expect(await harness.account.signOut().revoked == false)
        #expect(harness.requests(to: .revoke).count == 3)
        #expect(harness.store.saved?.session == nil)
    }

    @Test func aRefusedRevocationIsNotRetried() async {
        let harness = Harness()
        _ = await harness.signIn()
        harness.stub.script(.revoke, .reply(400, #"{"error": "invalid_request"}"#))
        #expect(await harness.account.signOut().revoked == false)
        #expect(harness.requests(to: .revoke).count == 1)
    }

    @Test func signingOutWhenSignedOutDoesNothing() async throws {
        let harness = Harness()
        #expect(await harness.account.signOut().revoked)
        #expect(harness.stub.requests.isEmpty)
    }
}

struct VaultTests {
    @Test func keepsTheHostAndClientIDFromF3ButNotItsUncheckedSession() throws {
        let f3 = #"""
            {"hostID": "6A2F41A3-C54C-4C3B-9E1A-1F4D2B3C4D5E", "clientID": "oaiapp_f3",
             "session": {"accessToken": "a", "refreshToken": "r", "scope": "openid", "expiresAt": 0, "email": "x@example.com"}}
            """#
        let vault = try JSONDecoder().decode(Vault.self, from: Data(f3.utf8))
        #expect(vault.hostID == UUID(uuidString: "6A2F41A3-C54C-4C3B-9E1A-1F4D2B3C4D5E"))
        #expect(vault.registrations == [Vault.Registration(clientID: "oaiapp_f3")])
        #expect(vault.session == nil)
    }

    @Test func readsBackWhatItSaves() throws {
        let vault = Vault(
            registrations: [Vault.Registration(clientID: "oaiapp_1", subject: "s", email: "e", idToken: "i")],
            session: Vault.Session(clientID: "oaiapp_1", accessToken: "a", refreshToken: "r", scope: "openid",
                                   expiresAt: Date(timeIntervalSince1970: 1_800_000_000), renewedAt: nil),
            ended: .lapsed)
        #expect(try JSONDecoder().decode(Vault.self, from: JSONEncoder().encode(vault)) == vault)
    }
}


struct AccountSwitchTests {
    @Test func switchingToAnotherAccountAndBackReusesTheFirstAccountsClientID() async throws {
        let harness = Harness()
        #expect(await harness.signIn() == nil)
        _ = await harness.account.signOut()
        harness.stub.identity.subject = "user-other"
        harness.stub.identity.email = "other@example.com"
        #expect(await harness.signIn(.anotherAccount, issuing: "oaiapp_other") == nil)
        _ = await harness.account.signOut()
        let other = AccountStatus.SavedAccount(id: "oaiapp_other", email: "other@example.com")
        #expect(await harness.account.status == .signedOut(accounts: [other, savedYou], ended: nil))

        harness.stub.identity.subject = "user-stub"
        harness.stub.identity.email = "you@example.com"
        let page = try await harness.signInPage(.returning, account: savedYou.id)
        #expect(page["client_id"] == StubOpenAI.issuedClientID)
        #expect(page["login_hint"] == "you@example.com")
        #expect(page["agent_name_hint"] == nil)
        #expect(await harness.signIn(.returning, account: savedYou.id) == nil)
        #expect(harness.store.saved?.session?.clientID == StubOpenAI.issuedClientID)
        #expect(harness.store.saved?.registrations.map(\.clientID) == ["oaiapp_other", StubOpenAI.issuedClientID])
        #expect(harness.requests(to: .exchange).map { fields($0)["client_id"] }
            == [StubOpenAI.issuedClientID, "oaiapp_other", StubOpenAI.issuedClientID])
        #expect(await harness.account.status == .signedIn(
            email: "you@example.com", scope: OpenAI.scope, expiresAt: harness.clock.now + 3600, renewedAt: nil))
    }

    @Test func returningToAnAccountAsSomeoneElseKeepsBothAccounts() async {
        let harness = Harness()
        _ = await harness.signIn()
        _ = await harness.account.signOut()
        harness.stub.identity.subject = "user-other"
        _ = await harness.signIn(.anotherAccount, issuing: "oaiapp_other")
        _ = await harness.account.signOut()
        #expect(await harness.signIn(.returning, account: savedYou.id) == .otherAccount)
        #expect(harness.store.saved?.registrations.map(\.subject) == ["user-stub", "user-other"])
        #expect(harness.store.saved?.session == nil)
    }

    @Test func anAccountThatIsNoLongerSavedIsRefused() async {
        let harness = Harness()
        #expect(await harness.signIn(.returning, account: "oaiapp_gone") == .unknownAccount)
        #expect(harness.requests(to: .exchange).isEmpty)
    }

    @Test func javaScriptReadsTheSavedAccountsByIDWithoutTokens() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        let idToken = try #require(harness.store.saved?.registrations.first?.idToken)
        _ = await harness.account.signOut()
        let record = await harness.account.snapshot.record
        let accounts = try #require(record["accounts"] as? [[String: String]])
        #expect(accounts == [["id": StubOpenAI.issuedClientID, "email": "you@example.com"]])
        #expect(record["returning"] as? [String: String] == ["email": "you@example.com"])
        let text = String(decoding: try JSONSerialization.data(withJSONObject: record), as: UTF8.self)
        for secret in [idToken, "stub-access-1", "stub-refresh-1"] {
            #expect(!text.contains(secret))
        }
    }
}

struct KeyRotationTests {
    func keySet(_ signer: StubSigner) throws -> String {
        String(decoding: try JSONEncoder().encode(signer.keySet), as: UTF8.self)
    }

    @Test func aKeyMissingFromTheKeptKeysFetchesThemAgainPastTheCache() async {
        let harness = Harness()
        #expect(await harness.signIn() == nil)
        _ = await harness.account.signOut()
        harness.stub.signer = StubOpenAI.rotated
        #expect(await harness.signIn() == nil)
        let fetches = harness.requests(to: .keys)
        #expect(fetches.count == 2)
        #expect(fetches.first?.value(forHTTPHeaderField: "Cache-Control") == nil)
        #expect(fetches.last?.value(forHTTPHeaderField: "Cache-Control") == "no-cache")
        #expect(fetches.last?.cachePolicy == .reloadIgnoringLocalCacheData)
    }

    @Test func keysServedStaleFromACacheAreFetchedAgainOnce() async throws {
        let harness = Harness()
        harness.stub.signer = StubOpenAI.rotated
        harness.stub.script(.keys, .reply(200, try keySet(StubOpenAI.signer)))
        #expect(await harness.signIn() == nil)
        #expect(harness.requests(to: .keys).count == 2)
        #expect(harness.store.saved?.session?.accessToken == "stub-access-1")
    }

    @Test func aKeyStillMissingAfterOneMoreFetchIsRefused() async throws {
        let harness = Harness()
        harness.stub.signer = StubOpenAI.rotated
        let stale = try keySet(StubOpenAI.signer)
        harness.stub.script(.keys, .reply(200, stale), .reply(200, stale), .reply(200, stale))
        #expect(await harness.signIn() == .identity(.unknownKey))
        #expect(harness.requests(to: .keys).count == 2)
        #expect(harness.store.saved?.session == nil)
    }
}

struct StorageFailureTests {
    @Test func aSignOutTheKeychainRefusesSaysSoAndDeletesTheTokensOnTheNextCall() async throws {
        let harness = Harness()
        _ = await harness.signIn()
        harness.store.failsWrites = true
        #expect(await harness.account.signOut() == SignOutResult(revoked: true, cleared: false))
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-1")
        #expect(await harness.account.snapshot == AccountSnapshot(
            status: .signedOut(accounts: [savedYou], ended: nil), unsaved: true))
        #expect(await harness.account.snapshot.record["unsaved"] as? Bool == true)
        #expect(await harness.account.bearer() == .failure(.signedOut))
        harness.store.failsWrites = false
        #expect(await harness.account.snapshot.unsaved == false)
        #expect(harness.store.saved?.session == nil)
        #expect(harness.store.saved?.registrations.map(\.clientID) == [StubOpenAI.issuedClientID])
    }

    @Test func aRotatedRefreshTokenTheKeychainRefusesIsKeptUsedAndSavedLater() async {
        let harness = Harness()
        _ = await harness.signIn()
        harness.store.failsWrites = true
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .success("stub-access-2"))
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-1")
        #expect(await harness.account.snapshot.unsaved)
        harness.clock.advance(3600)
        #expect(await harness.account.bearer() == .success("stub-access-3"))
        #expect(harness.requests(to: .refresh).map { fields($0)["refresh_token"] } == ["stub-refresh-1", "stub-refresh-2"])
        harness.store.failsWrites = false
        #expect(await harness.account.renewIfDue() == nil)
        #expect(harness.store.saved?.session?.refreshToken == "stub-refresh-3")
        #expect(await harness.account.snapshot.unsaved == false)
    }

    @Test func aKeychainThatCannotBeReadIsNeverWrittenOver() async {
        let saved = Vault(registrations: [Vault.Registration(clientID: StubOpenAI.issuedClientID, subject: "user-stub")])
        let harness = Harness(vault: saved)
        harness.store.failsReads = true
        #expect(await harness.signIn() == .storage)
        #expect(await harness.account.snapshot.unsaved)
        #expect(await harness.account.signOut().cleared == false)
        #expect(harness.store.saved == saved)
        harness.store.failsReads = false
        #expect(await harness.account.status == .signedOut(
            accounts: [.init(id: StubOpenAI.issuedClientID, email: nil)], ended: nil))
        #expect(await harness.signIn() == nil)
        #expect(harness.store.saved?.hostID == saved.hostID)
        #expect(harness.requests(to: .exchange).map { fields($0)["client_id"] } == [StubOpenAI.issuedClientID])
    }
}
