import UIKit

/// How the sign-in page is shown.
enum SignInRoute: String, Sendable {
    /// The system's sign-in sheet, inside the app.
    case sheet
    /// Safari. The app is in the background while the user signs in, so iOS may have suspended it by
    /// the time ChatGPT sends the browser back. The user then pastes the address Safari could not open.
    case safari
}

enum SignInOutcome: Sendable {
    case signedIn(AccountSnapshot)
    case failed(SignInProblem)
    case cancelled

    var record: [String: Any] {
        switch self {
        case .signedIn(let snapshot): ["status": "signedIn", "account": snapshot.record]
        case .failed(let problem): ["status": "failed", "problem": problem.code]
        case .cancelled: ["status": "cancelled"]
        }
    }
}

/// The system pasteboard, read only in Swift.
struct SystemPasteboard: AddressPasteboard {
    var text: String? { UIPasteboard.general.string }

    func clear() { UIPasteboard.general.items = [] }
}

/// One sign-in from start to finish: the loopback listener, the sheet or Safari, the paste, and the
/// code exchange. The tokens stay in `ChatGPTAccount`.
@MainActor
final class SignInFlow {
    private let account: ChatGPTAccount
    /// The page the browser opens for an authorize address. The stand-in mode swaps in its own.
    private let signInPage: (URL) -> URL
    private let web = WebSignIn()
    private var attempt: Attempt?

    private struct Attempt {
        let route: SignInRoute
        let events: AsyncStream<SignInEvent>.Continuation
        var signIn: SignInAttempt?
    }

    private enum SignInEvent {
        case callback(String)
        /// The code was exchanged for tokens, or the exchange failed with this problem.
        case exchanged(SignInProblem?)
        case sheetClosed
        case cancelled
        case timedOut
    }

    /// Long enough for a password manager and a second factor. The listener is not left open after it.
    private static let signInTimeLimit: Duration = .seconds(600)
    /// The port in the redirect address when no listener could start. Nothing listens on it, and the
    /// sign-in is finished by pasting the address.
    private static let portWithoutListener: UInt16 = 1455

    init(account: ChatGPTAccount, signInPage: @escaping (URL) -> URL = { $0 }) {
        self.account = account
        self.signInPage = signInPage
    }

    func signIn(by route: SignInRoute, choice: SignInChoice, account savedAccount: String?) async -> SignInOutcome {
        guard attempt == nil else { return .failed(.busy) }
        let (events, feed) = AsyncStream.makeStream(of: SignInEvent.self)
        attempt = Attempt(route: route, events: feed)
        let reply: LoopbackCallback.Reply = route == .sheet
            ? .redirect(WebSignIn.done) : .page("Signed in. Go back to svett.")
        let listener = try? await LoopbackCallback.start(reply: reply) { feed.yield(.callback($0)) }
        let begun: (attempt: SignInAttempt, page: URL)
        switch await account.beginSignIn(
            port: listener?.port ?? Self.portWithoutListener, choice: choice, account: savedAccount) {
        case .success(let started): begun = started
        case .failure(let problem):
            listener?.stop()
            attempt = nil
            return .failed(problem)
        }
        attempt?.signIn = begun.attempt
        let page = signInPage(begun.page)
        switch route {
        case .sheet: web.open(page) { feed.yield(.sheetClosed) }
        case .safari: UIApplication.shared.open(page, options: [:], completionHandler: nil)
        }
        let timeLimit = Task {
            guard (try? await Task.sleep(for: Self.signInTimeLimit)) != nil else { return }
            feed.yield(.timedOut)
        }

        // The exchange runs beside this loop, so that Cancel and the time limit still count while
        // the code is turned into tokens.
        var outcome = SignInOutcome.cancelled
        var exchange: Task<Void, Never>?
        waiting: for await event in events {
            switch event {
            case .callback(let address):
                guard exchange == nil else { continue }
                switch begun.attempt.grant(from: address) {
                case .success(let grant):
                    listener?.stop()
                    web.close()
                    exchange = Task { [account] in
                        feed.yield(.exchanged(await account.finishSignIn(begun.attempt, grant)))
                    }
                case .failure(.notTheAddress), .failure(.otherAttempt):
                    // Not an answer to this attempt. A stray request to the listener is ignored, and
                    // a wrong paste is reported by `paste`.
                    continue
                case .failure(let problem):
                    outcome = .failed(problem)
                    break waiting
                }
            case .exchanged(let problem):
                if let problem {
                    outcome = .failed(problem)
                } else {
                    let snapshot = await account.snapshot
                    if case .signedIn = snapshot.status {
                        outcome = .signedIn(snapshot)
                    } else {
                        outcome = .failed(.refused)
                    }
                }
                break waiting
            case .sheetClosed:
                // The sheet also closes when the sign-in page has answered.
                if exchange == nil { break waiting }
            case .cancelled:
                break waiting
            case .timedOut:
                outcome = .failed(.timedOut)
                break waiting
            }
        }
        timeLimit.cancel()
        exchange?.cancel()
        listener?.stop()
        web.close()
        attempt = nil
        return outcome
    }

    /// Finishes a Safari sign-in with the address that Safari was sent to and could not open, read
    /// from `pasteboard`. Returns why it cannot finish this sign-in, or nil when it was taken.
    func paste(from pasteboard: any AddressPasteboard) -> SignInProblem? {
        guard let attempt, let signIn = attempt.signIn else { return .notRunning }
        switch signIn.answer(on: pasteboard) {
        case .success(let address):
            attempt.events.yield(.callback(address))
            return nil
        case .failure(let problem):
            return problem
        }
    }

    func cancel() {
        attempt?.events.yield(.cancelled)
    }
}
