import ExpoModulesCore

/// Fixed for the life of the process, so a value saved by an earlier launch can be told apart from
/// one saved by this launch, also across JavaScript reloads.
private let processLaunch = Date()

/// The ChatGPT sign-in, or its stand-in when the app was launched with `-svettChatGPTStub`.
private let chatGPT = ChatGPTStub.make() ?? (
    account: ChatGPTAccount(transport: URLSessionTransport(), store: KeychainVaultStore()),
    signInPage: { $0 })
@MainActor private let signInFlow = SignInFlow(account: chatGPT.account, signInPage: chatGPT.signInPage)

public class SvettNativeModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SvettNative")

        OnCreate { _ = processLaunch }

        Constant("launchedAt") { processLaunch.timeIntervalSince1970 * 1000 }

        Function("signedEntitlements") { () -> [String]? in
            SignedEntitlements.keys()
        }

        AsyncFunction("requestWorkoutAccess") { (promise: Promise) in
            Task { promise.resolve(await WorkoutAccess.request()) }
        }

        // Nothing below hands JavaScript a token. It gets the account's status and problem codes.
        AsyncFunction("chatGPTStatus") { (promise: Promise) in
            Task { promise.resolve(await chatGPT.account.snapshot.record) }
        }

        AsyncFunction("renewChatGPT") { (promise: Promise) in
            Task {
                let problem = await chatGPT.account.renewIfDue()
                var record: [String: Any] = ["account": await chatGPT.account.snapshot.record]
                if let problem { record["problem"] = problem.code }
                promise.resolve(record)
            }
        }

        // `account` is a saved account's id from the status, or null for the one used last.
        AsyncFunction("signInWithChatGPT") { (route: String, choice: String, account: String?, promise: Promise) in
            Task { @MainActor in
                let outcome = await signInFlow.signIn(
                    by: SignInRoute(rawValue: route) ?? .sheet, choice: SignInChoice(rawValue: choice) ?? .returning,
                    account: account)
                promise.resolve(outcome.record)
            }
        }

        // Swift reads the pasteboard, so the address and its code never cross to JavaScript.
        AsyncFunction("pasteSignInAddress") { (promise: Promise) in
            Task { @MainActor in promise.resolve(signInFlow.paste(from: SystemPasteboard())?.code) }
        }

        AsyncFunction("cancelSignIn") { (promise: Promise) in
            Task { @MainActor in
                signInFlow.cancel()
                promise.resolve()
            }
        }

        AsyncFunction("signOutOfChatGPT") { (promise: Promise) in
            Task { promise.resolve(await chatGPT.account.signOut().record) }
        }
    }
}
