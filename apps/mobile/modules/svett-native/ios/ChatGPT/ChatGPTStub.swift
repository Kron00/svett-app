import Foundation

/// The `-svettChatGPTStub <scenario>` launch argument runs the sign-in against `StubOpenAI` and a
/// vault in memory, so scripts/sim/chatgpt.sh can show each state without an account or the network.
enum ChatGPTStub {
    static func make() -> (account: ChatGPTAccount, signInPage: (URL) -> URL)? {
        guard let scenario = UserDefaults.standard.string(forKey: "svettChatGPTStub") else { return nil }
        let stub = StubOpenAI()
        switch scenario {
        case "lapsed": stub.script(.refresh, .reply(400, #"{"error": "invalid_grant"}"#))
        case "revokeFails": stub.script(.revoke, .reply(503, ""), .reply(503, ""), .reply(503, ""))
        case "badSignature": stub.identity.signedByStranger = true
        case "wrongAudience": stub.identity.audience = "oaiapp_another_app"
        case "expiredToken": stub.identity.lifetime = -60
        default: break
        }
        let account = ChatGPTAccount(transport: stub, store: MemoryVaultStore(vault(for: scenario)))
        return (account: account, signInPage: StubOpenAI.signInPage)
    }

    private static func vault(for scenario: String) -> Vault? {
        let registration = Vault.Registration(
            clientID: StubOpenAI.issuedClientID, subject: StubOpenAI.Identity().subject,
            email: StubOpenAI.Identity().email)
        func session(scope: String = OpenAI.scope, expiresIn: TimeInterval) -> Vault.Session {
            Vault.Session(clientID: registration.clientID, accessToken: "stub-access-0", refreshToken: "stub-refresh-0",
                          scope: scope, expiresAt: .now.addingTimeInterval(expiresIn))
        }
        return switch scenario {
        case "returning": Vault(registrations: [registration])
        case "signedIn", "revokeFails": Vault(registrations: [registration], session: session(expiresIn: 3600))
        case "noPlanUsage":
            Vault(registrations: [registration], session: session(scope: "openid profile email offline_access", expiresIn: 3600))
        case "renews", "lapsed": Vault(registrations: [registration], session: session(expiresIn: -60))
        default: nil
        }
    }
}
