import Foundation

extension OpenAI {
    /// Where the coach's model requests go. Requests on the user's plan must stream and must not be stored.
    static let responses = URL(string: "https://api.openai.com/v1/responses")!
}

/// What JavaScript hears while one coach request streams. It carries the answer's text, the tool
/// calls the model asks for and how the request ended, and never a token.
enum CoachEvent: Equatable, Sendable {
    case started
    case text(String)
    case toolCall(callID: String, name: String, namespace: String?, arguments: String)
    case done
    /// `code` is OpenAI's error code, `http<status>` for an error without one, or one of svett's own:
    /// `interrupted`, `unreachable`, `badRequest`, or an `AccountProblem` code.
    case failed(code: String, status: Int?)

    var isEnd: Bool {
        switch self {
        case .done, .failed: true
        default: false
        }
    }

    var record: [String: Any] {
        switch self {
        case .started: return ["type": "started"]
        case .text(let delta): return ["type": "text", "delta": delta]
        case let .toolCall(callID, name, namespace, arguments):
            var record: [String: Any] = ["type": "toolCall", "callId": callID, "name": name, "arguments": arguments]
            if let namespace { record["namespace"] = namespace }
            return record
        case .done: return ["type": "done"]
        case let .failed(code, status):
            var record: [String: Any] = ["type": "failed", "code": code]
            if let status { record["status"] = status }
            return record
        }
    }

    init?(record: [String: Any]) {
        switch record["type"] as? String {
        case "started": self = .started
        case "text":
            guard let delta = record["delta"] as? String else { return nil }
            self = .text(delta)
        case "toolCall":
            guard let callID = record["callId"] as? String, let name = record["name"] as? String,
                  let arguments = record["arguments"] as? String else { return nil }
            self = .toolCall(callID: callID, name: name, namespace: record["namespace"] as? String, arguments: arguments)
        case "done": self = .done
        case "failed":
            guard let code = record["code"] as? String else { return nil }
            self = .failed(code: code, status: record["status"] as? Int)
        default: return nil
        }
    }
}

/// Reads the Responses API's server-sent events, one line at a time, into `CoachEvent`s. It reads
/// only the `data:` lines, because each one's JSON names its own type. It does not wait for the
/// blank line that ends an event, since a line reader may drop blank lines.
struct ResponsesStreamParser {
    private(set) var ended = false
    private var data = ""

    mutating func feed(_ line: String) -> CoachEvent? {
        guard !ended else { return nil }
        let line = line.hasSuffix("\r") ? String(line.dropLast()) : line
        if line.isEmpty {
            data = ""
            return nil
        }
        guard line.hasPrefix("data:") else { return nil }
        var payload = line.dropFirst(5)
        if payload.hasPrefix(" ") { payload = payload.dropFirst() }
        if payload == "[DONE]" { return nil }
        data += data.isEmpty ? String(payload) : "\n" + String(payload)
        guard let object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else {
            // Part of an event that spans several data lines. The next line completes it.
            return nil
        }
        data = ""
        let event = Self.event(object)
        if event?.isEnd == true { ended = true }
        return event
    }

    /// The event for a stream that stopped. A stream that ends before OpenAI said it was complete
    /// did not finish its answer.
    mutating func end() -> CoachEvent? {
        guard !ended else { return nil }
        ended = true
        return .failed(code: "interrupted", status: nil)
    }

    private static func event(_ object: [String: Any]) -> CoachEvent? {
        switch object["type"] as? String {
        case "response.created":
            return .started
        case "response.output_text.delta":
            return (object["delta"] as? String).map(CoachEvent.text)
        case "response.output_item.done":
            guard let item = object["item"] as? [String: Any], item["type"] as? String == "function_call",
                  let callID = item["call_id"] as? String, let name = item["name"] as? String else { return nil }
            return .toolCall(callID: callID, name: name, namespace: item["namespace"] as? String,
                             arguments: item["arguments"] as? String ?? "{}")
        case "response.completed":
            return .done
        case "response.failed":
            let response = object["response"] as? [String: Any]
            let error = response?["error"] as? [String: Any]
            return .failed(code: error?["code"] as? String ?? "failed", status: nil)
        case "response.incomplete":
            return .failed(code: "incomplete", status: nil)
        case "error":
            let nested = object["error"] as? [String: Any]
            return .failed(code: object["code"] as? String ?? nested?["code"] as? String ?? "error", status: nil)
        default:
            return nil
        }
    }

    /// The event for an answer that was not a stream, from its status and body.
    static func refusal(status: Int, body: String) -> CoachEvent {
        .failed(code: OpenAI.errorCode(in: Data(body.utf8)) ?? "http\(status)", status: status)
    }
}

/// The network as the coach uses it: a request, and the lines of its answer as they arrive.
protocol StreamingTransport: Sendable {
    func stream(_ request: URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>)
}

struct URLSessionStreamingTransport: StreamingTransport {
    private let session = URLSession(configuration: .ephemeral)

    func stream(_ request: URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let (bytes, response) = try await session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let reading = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
        return (status, lines)
    }
}

/// Sends the coach's requests on the user's plan. JavaScript builds the body. This adds the
/// access token, which never leaves Swift, and passes back only `CoachEvent`s.
actor CoachClient {
    private let account: ChatGPTAccount
    private let transport: any StreamingTransport
    private let recorder: CoachRecorder?

    init(account: ChatGPTAccount, transport: any StreamingTransport, recorder: CoachRecorder? = nil) {
        self.account = account
        self.transport = transport
        self.recorder = recorder
    }

    /// Sends one request and calls `onEvent` for each event, in order. The last event is always
    /// `done` or `failed`. It never sends the request twice.
    func send(_ body: Data, onEvent: @escaping @Sendable (CoachEvent) -> Void) async {
        var events: [CoachEvent] = []
        var raw = ""
        var status = 0
        let emit = { (event: CoachEvent) in
            events.append(event)
            onEvent(event)
        }
        guard var object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            return emit(.failed(code: "badRequest", status: nil))
        }
        // OpenAI refuses plan requests that are stored or do not stream.
        object["stream"] = true
        object["store"] = false
        guard let sent = try? JSONSerialization.data(withJSONObject: object) else {
            return emit(.failed(code: "badRequest", status: nil))
        }
        let token: String
        switch await account.bearer() {
        case .success(let bearer): token = bearer
        case .failure(let problem): return emit(.failed(code: problem.code, status: nil))
        }
        var request = URLRequest(url: OpenAI.responses)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = sent

        do {
            let answer = try await transport.stream(request)
            status = answer.status
            var parser = ResponsesStreamParser()
            var lines: [String] = []
            for try await line in answer.lines {
                lines.append(line)
                if status == 200, let event = parser.feed(line) { emit(event) }
            }
            raw = lines.joined(separator: "\n")
            if status == 200 {
                if let end = parser.end() { emit(end) }
            } else {
                emit(ResponsesStreamParser.refusal(status: status, body: raw))
            }
        } catch {
            if !(events.last?.isEnd ?? false) { emit(.failed(code: Task.isCancelled ? "cancelled" : "unreachable", status: nil)) }
        }
        recorder?.record(request: object, status: status, body: raw, events: events)
    }
}

/// Keeps every exchange of a live run in a file, in the fixture shape the coach's tests replay:
/// the request body svett built, the status, the raw answer and the events JavaScript got. The
/// request's headers, and with them the token, are never written.
final class CoachRecorder: @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()
    private let startedAt: Date
    private var exchanges: [[String: Any]] = []

    init(url: URL, now: Date = .now) {
        self.url = url
        startedAt = now
    }

    func record(request: [String: Any], status: Int, body: String, events: [CoachEvent]) {
        lock.withLock {
            exchanges.append([
                "request": request, "status": status, "body": body, "events": events.map(\.record),
            ])
            let fixture: [String: Any] = [
                "source": "live",
                "recordedAt": (startedAt.timeIntervalSince1970 * 1000).rounded(),
                "exchanges": exchanges,
            ]
            guard let data = try? JSONSerialization.data(
                withJSONObject: fixture, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}

/// Answers the coach's requests from a recorded fixture, in order, starting over after the last.
/// The `-svettCoachStub <path>` launch argument runs the app on it, so scripts/sim/coach.sh shows
/// the coach without an account or the network.
final class StubResponses: StreamingTransport, @unchecked Sendable {
    private let answers: [(status: Int, body: String)]
    private let lock = NSLock()
    private var next = 0
    private var sent: [URLRequest] = []
    /// The pause between lines, so the simulator shows the answer arriving.
    private let pause: Duration

    var requests: [URLRequest] { lock.withLock { sent } }

    init(answers: [(status: Int, body: String)], pause: Duration = .zero) {
        self.answers = answers
        self.pause = pause
    }

    /// Reads the exchanges of a fixture file, or nil when it holds none.
    convenience init?(fixture: Data, pause: Duration = .zero) {
        guard let object = (try? JSONSerialization.jsonObject(with: fixture)) as? [String: Any],
              let exchanges = object["exchanges"] as? [[String: Any]] else { return nil }
        let answers = exchanges.compactMap { exchange -> (status: Int, body: String)? in
            guard let status = exchange["status"] as? Int, let body = exchange["body"] as? String else { return nil }
            return (status, body)
        }
        guard !answers.isEmpty else { return nil }
        self.init(answers: answers, pause: pause)
    }

    func stream(_ request: URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let answer = lock.withLock {
            sent.append(request)
            defer { next = (next + 1) % answers.count }
            return answers[next]
        }
        let pause = self.pause
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let feeding = Task {
                for line in answer.body.split(separator: "\n", omittingEmptySubsequences: false) {
                    if pause > .zero, line.hasPrefix("data:") { try? await Task.sleep(for: pause) }
                    continuation.yield(String(line))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in feeding.cancel() }
        }
        return (answer.status, lines)
    }
}
