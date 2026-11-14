import Darwin
import ExpoModulesCore

/// Fixed for the life of the process, so a value saved by an earlier launch can be told apart from
/// one saved by this launch, also across JavaScript reloads. The kernel's start time of the process
/// counts the work before this module exists, which the cold start timing needs.
private let processLaunch: Date = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0 else { return Date() }
    let started = info.kp_proc.p_un.__p_starttime
    return Date(timeIntervalSince1970: TimeInterval(started.tv_sec) + TimeInterval(started.tv_usec) / 1_000_000)
}()

/// The ChatGPT sign-in, or its stand-in when the app was launched with `-svettChatGPTStub`.
private let chatGPT = ChatGPTStub.make() ?? (
    account: ChatGPTAccount(transport: URLSessionTransport(), store: KeychainVaultStore()),
    signInPage: { $0 })
@MainActor private let signInFlow = SignInFlow(account: chatGPT.account, signInPage: chatGPT.signInPage)
private let coach = CoachRequests(client: CoachLaunch.client(account: chatGPT.account))

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

        Events("onCoachEvent")

        // Streams one coach request. Each event goes to JavaScript tagged with `requestId`, and the
        // last is always `done` or `failed`. The access token stays here.
        AsyncFunction("sendCoachRequest") { (requestID: String, body: String, promise: Promise) in
            Task {
                let request = await coach.start(requestID, body: Data(body.utf8)) { [weak self] event in
                    var record = event.record
                    record["requestId"] = requestID
                    self?.sendEvent("onCoachEvent", record.mapValues { $0 as Any? })
                }
                await request.value
                promise.resolve()
            }
        }

        // Stops a coach request that is still streaming, when JavaScript no longer waits for it.
        AsyncFunction("cancelCoachRequest") { (requestID: String, promise: Promise) in
            Task {
                await coach.cancel(requestID)
                promise.resolve()
            }
        }
    }
}
