import ExpoModulesCore

/// Fixed for the life of the process, so a value saved by an earlier launch can be told apart from
/// one saved by this launch, also across JavaScript reloads.
private let processLaunch = Date()

private let chatGPTAccount = ChatGPTAccount(store: KeychainVaultStore())
@MainActor private let signInFlow = SignInFlow(account: chatGPTAccount)

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

        AsyncFunction("chatGPTSession") { (promise: Promise) in
            Task { promise.resolve(await chatGPTAccount.session?.record) }
        }

        AsyncFunction("signInWithChatGPT") { (route: String, promise: Promise) in
            Task { @MainActor in
                let outcome = await signInFlow.signIn(by: SignInRoute(rawValue: route) ?? .sheet)
                promise.resolve(outcome.record)
            }
        }

        AsyncFunction("pasteSignInAddress") { (address: String, promise: Promise) in
            Task { @MainActor in promise.resolve(signInFlow.paste(address)) }
        }

        AsyncFunction("cancelSignIn") { (promise: Promise) in
            Task { @MainActor in
                signInFlow.cancel()
                promise.resolve()
            }
        }
    }
}
