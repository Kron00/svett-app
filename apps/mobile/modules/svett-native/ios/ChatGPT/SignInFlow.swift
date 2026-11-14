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
    case signedIn(SessionSummary)
    case failed(String)
    case cancelled

    var record: [String: Any] {
        switch self {
        case .signedIn(let session): ["status": "signedIn", "session": session.record]
        case .failed(let problem): ["status": "failed", "problem": problem]
        case .cancelled: ["status": "cancelled"]
        }
    }
}

/// One sign-in from start to finish: the loopback listener, the sheet or Safari, the paste, and the
/// code exchange. The tokens stay in `ChatGPTAccount`.
@MainActor
final class SignInFlow {
    private let account: ChatGPTAccount
    private let web = WebSignIn()
    private var attempt: Attempt?

    private struct Attempt {
        let route: SignInRoute
        let events: AsyncStream<SignInEvent>.Continuation
        var signIn: SignInAttempt?
    }

    private enum SignInEvent {
        case callback(String, pasted: Bool)
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

    init(account: ChatGPTAccount) {
        self.account = account
    }

    func signIn(by route: SignInRoute) async -> SignInOutcome {
        guard attempt == nil else { return .failed("A sign-in is already running.") }
        let (events, feed) = AsyncStream.makeStream(of: SignInEvent.self)
        attempt = Attempt(route: route, events: feed)
        let reply: LoopbackCallback.Reply = route == .sheet
            ? .redirect(WebSignIn.done) : .page("Signed in. Go back to svett.")
        let listener = try? await LoopbackCallback.start(reply: reply) { feed.yield(.callback($0, pasted: false)) }
        let begun = await account.beginSignIn(port: listener?.port ?? Self.portWithoutListener)
        attempt?.signIn = begun.attempt
        switch route {
        case .sheet: web.open(begun.page) { feed.yield(.sheetClosed) }
        case .safari: UIApplication.shared.open(begun.page, options: [:], completionHandler: nil)
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
            case .callback(let address, _):
                guard exchange == nil else { continue }
                do {
                    let grant = try begun.attempt.grant(from: address)
                    listener?.stop()
                    web.close()
                    exchange = Task { [account] in
                        do throws(SignInProblem) {
                            try await account.finishSignIn(begun.attempt, grant)
                            feed.yield(.exchanged(nil))
                        } catch {
                            feed.yield(.exchanged(error))
                        }
                    }
                } catch {
                    if error == .denied || error == .refused {
                        outcome = .failed(error.message)
                        break waiting
                    }
                    // Not an answer to this attempt. A stray request to the listener is ignored, and
                    // a wrong paste is reported by `paste`.
                }
            case .exchanged(let problem):
                if let problem {
                    outcome = .failed(problem.message)
                } else if let session = await account.session {
                    outcome = .signedIn(session)
                } else {
                    outcome = .failed(SignInProblem.refused.message)
                }
                break waiting
            case .sheetClosed:
                // The sheet also closes when the sign-in page has answered.
                if exchange == nil { break waiting }
            case .cancelled:
                break waiting
            case .timedOut:
                outcome = .failed(SignInProblem.timedOut.message)
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

    /// Finishes a Safari sign-in with the address that Safari was sent to and could not open. Returns
    /// why the address cannot finish this sign-in, or nil when it was taken.
    func paste(_ address: String) -> String? {
        guard let attempt, let signIn = attempt.signIn else { return "No sign-in is running." }
        do {
            _ = try signIn.grant(from: address)
        } catch {
            if error == .notTheAddress || error == .otherAttempt { return error.message }
        }
        attempt.events.yield(.callback(address, pasted: true))
        return nil
    }

    func cancel() {
        attempt?.events.yield(.cancelled)
    }
}
