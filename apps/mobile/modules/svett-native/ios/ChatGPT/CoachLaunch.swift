import Foundation

/// The coach's client for this launch. `-svettCoachStub <path>` answers from a recorded fixture
/// instead of OpenAI, and `-svettCoachRecord <path>` writes every exchange of a live run to a
/// fixture file. Only scripts/sim/coach.sh passes either.
enum CoachLaunch {
    static func client(account: ChatGPTAccount) -> CoachClient {
        let defaults = UserDefaults.standard
        let recorder = defaults.string(forKey: "svettCoachRecord").map {
            CoachRecorder(url: URL(fileURLWithPath: $0))
        }
        if let path = defaults.string(forKey: "svettCoachStub"),
           let fixture = FileManager.default.contents(atPath: path),
           let stub = StubResponses(fixture: fixture, pause: .milliseconds(25)) {
            return CoachClient(account: account, transport: stub, recorder: recorder)
        }
        return CoachClient(account: account, transport: URLSessionStreamingTransport(), recorder: recorder)
    }
}
