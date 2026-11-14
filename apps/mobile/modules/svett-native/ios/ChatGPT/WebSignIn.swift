import AuthenticationServices
import UIKit

/// The system's sign-in sheet. It shares Safari's cookies, so someone already signed in to ChatGPT
/// in Safari only has to approve. It reports nothing but its own closing: the sign-in answer arrives
/// at `LoopbackCallback`, because the sheet can only watch for a custom scheme and OpenAI redirects
/// only to 127.0.0.1.
@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    /// The loopback listener sends the sheet here once it has the answer, and the sheet closes.
    static let scheme = "svett-auth"
    static let done = URL(string: "\(scheme)://done")!

    private var session: ASWebAuthenticationSession?

    /// Shows `page`. `closed` runs when the sheet goes away, whether the listener sent it to `done`
    /// or the user closed it.
    func open(_ page: URL, closed: @escaping @MainActor () -> Void) {
        let session = ASWebAuthenticationSession(url: page, callback: .customScheme(Self.scheme)) { _, _ in
            Task { @MainActor in closed() }
        }
        session.presentationContextProvider = self
        self.session = session
        if !session.start() { closed() }
    }

    func close() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.compactMap(\.keyWindow).first ?? scenes.first.map(UIWindow.init(windowScene:)) ?? ASPresentationAnchor()
    }
}
