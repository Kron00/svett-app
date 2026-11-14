import Foundation
import Testing
@testable import ChatGPTCore

/// The coach's fixtures, which the TypeScript tests replay too.
private func fixture(_ name: String) throws -> [String: Any] {
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: repo.appending(path: "packages/tools/fixtures/\(name)"))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func parse(_ body: String) -> [CoachEvent] {
    var parser = ResponsesStreamParser()
    var events = ResponsesStreamParser.lines(of: body).compactMap { parser.feed(String($0)) }
    if let end = parser.end() { events.append(end) }
    return events
}

/// Collects what JavaScript would hear.
private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [CoachEvent] = []
    var events: [CoachEvent] { lock.withLock { list } }
    func add(_ event: CoachEvent) { lock.withLock { list.append(event) } }
}

private let signedIn = Vault(
    registrations: [Vault.Registration(clientID: StubOpenAI.issuedClientID, subject: "user-stub")],
    session: Vault.Session(clientID: StubOpenAI.issuedClientID, accessToken: "stub-access-0", refreshToken: "stub-refresh-0",
                           scope: OpenAI.scope, expiresAt: Date(timeIntervalSince1970: 1_800_003_600)))

private func send(_ body: String, answers: [(status: Int, body: String)], vault: Vault? = signedIn,
                  recorder: CoachRecorder? = nil) async -> (heard: [CoachEvent], stub: StubResponses) {
    let harness = Harness(vault: vault)
    let stub = StubResponses(answers: answers)
    let client = CoachClient(account: harness.account, transport: stub, recorder: recorder)
    let heard = Heard()
    await client.send(Data(body.utf8)) { heard.add($0) }
    return (heard.events, stub)
}

private let question = #"{"model": "gpt-6.1-sol", "instructions": "Coach", "input": [], "stream": true, "store": false}"#

struct CoachStreamTests {
    @Test(arguments: [
        "coach-best-squat.json", "coach-plan-limit.json", "coach-propose-routine.json",
        "coach-propose-program.json", "coach-propose-malformed.json",
    ])
    func eachRecordedAnswerBecomesTheEventsJavaScriptReplays(name: String) throws {
        let exchanges = try #require(try fixture(name)["exchanges"] as? [[String: Any]])
        #expect(!exchanges.isEmpty)
        for exchange in exchanges {
            let status = try #require(exchange["status"] as? Int)
            let body = try #require(exchange["body"] as? String)
            let expected = try #require(exchange["events"] as? [[String: Any]]).compactMap(CoachEvent.init(record:))
            let parsed = status == 200 ? parse(body) : [ResponsesStreamParser.refusal(status: status, body: body)]
            #expect(parsed == expected)
        }
    }

    @Test func aFunctionCallComesThroughWithItsNamespaceAndWholeArguments() {
        let body = """
            data: {"type":"response.created","response":{"id":"r"}}
            data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"best_sets","namespace":"svett","arguments":""}}
            data: {"type":"response.function_call_arguments.delta","item_id":"fc","output_index":0,"delta":"{\\"limit\\""}
            data: {"type":"response.function_call_arguments.done","item_id":"fc","output_index":0,"arguments":"{\\"limit\\":1}"}
            data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"best_sets","namespace":"svett","arguments":"{\\"limit\\":1}"}}
            data: {"type":"response.completed","response":{"id":"r","status":"completed"}}
            """
        #expect(parse(body) == [
            .started,
            .toolCall(callID: "c1", name: "best_sets", namespace: "svett", arguments: #"{"limit":1}"#),
            .done,
        ])
    }

    @Test func thePlanLimitInTheMiddleOfAStreamEndsIt() {
        let body = """
            event: response.created
            data: {"type":"response.created","response":{"id":"r"}}

            event: response.output_text.delta
            data: {"type":"response.output_text.delta","delta":"Your best"}

            event: response.failed
            data: {"type":"response.failed","response":{"status":"failed","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Limit"}}}

            event: response.output_text.delta
            data: {"type":"response.output_text.delta","delta":" after the end"}
            """
        #expect(parse(body) == [
            .started, .text("Your best"), .failed(code: "subscription_sharing_usage_limit_exceeded", status: nil),
        ])
    }

    @Test func anIncompleteAnswerAnErrorEventAndACutStreamEachFail() {
        #expect(parse(#"data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#)
            == [.failed(code: "incomplete", status: nil)])
        #expect(parse(#"data: {"type":"error","code":"server_error","message":"Oops"}"#)
            == [.failed(code: "server_error", status: nil)])
        #expect(parse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Your\"}\n")
            == [.text("Your"), .failed(code: "interrupted", status: nil)])
    }

    @Test func anEventSplitOverTwoDataLinesStillReads() {
        let body = "data: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"Hi\"}\r\n\r\ndata: {\"type\":\"response.completed\"}"
        #expect(parse(body) == [.text("Hi"), .done])
    }

    @Test func anErrorAnswerNamesOpenAIsCodeOrTheStatus() {
        #expect(ResponsesStreamParser.refusal(
            status: 400, body: #"{"error":{"code":"subscription_sharing_unsupported_capability","param":"tools"}}"#)
            == .failed(code: "subscription_sharing_unsupported_capability", status: 400))
        #expect(ResponsesStreamParser.refusal(status: 403, body: #"{"detail":"Not allowed"}"#)
            == .failed(code: "http403", status: 403))
    }

    @Test func aRequestCarriesTheTokenOnlyInItsHeaderAndAlwaysStreamsUnstored() async throws {
        let answer = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\ndata: {\"type\":\"response.completed\"}"
        let body = #"{"model": "gpt-6.1-sol", "instructions": "Coach", "input": [], "stream": false, "store": true}"#
        let (heard, stub) = await send(body, answers: [(200, answer)])
        #expect(heard == [.text("Hi"), .done])
        let request = try #require(stub.requests.first)
        #expect(stub.requests.count == 1)
        #expect(request.url == OpenAI.responses)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer stub-access-0")
        let httpBody = try #require(request.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: httpBody) as? [String: Any])
        #expect(sent["stream"] as? Bool == true)
        #expect(sent["store"] as? Bool == false)
        let records = try JSONSerialization.data(withJSONObject: heard.map(\.record))
        #expect(!String(decoding: records, as: UTF8.self).contains("stub-access"))
    }

    @Test func thePlanLimitIsSentOnceAndNeverAgain() async {
        let limit = #"{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Limit"}}"#
        let (heard, stub) = await send(question, answers: [(429, limit), (200, "")])
        #expect(heard == [.failed(code: "subscription_sharing_usage_limit_exceeded", status: 429)])
        #expect(stub.requests.count == 1)
    }

    @Test func withoutASignInOrPlanUsageNothingIsSent() async {
        let (signedOut, none) = await send(question, answers: [(200, "")], vault: nil)
        #expect(signedOut == [.failed(code: "signedOut", status: nil)])
        #expect(none.requests.isEmpty)

        var noPlan = signedIn
        noPlan.session?.scope = "openid profile email offline_access"
        let (refused, stub) = await send(question, answers: [(200, "")], vault: noPlan)
        #expect(refused == [.failed(code: "planUsageOff", status: nil)])
        #expect(stub.requests.isEmpty)
    }

    @Test func aBodyThatIsNotJSONIsNotSent() async {
        let (heard, stub) = await send("not json", answers: [(200, "")])
        #expect(heard == [.failed(code: "badRequest", status: nil)])
        #expect(stub.requests.isEmpty)
    }

    @Test func aRecordedRunHoldsTheBodyTheAnswerAndTheEventsButNoToken() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "coach-record-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let answer = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\ndata: {\"type\":\"response.completed\"}"
        _ = await send(question, answers: [(200, answer)], recorder: CoachRecorder(url: file))
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(!text.contains("stub-access"))
        let recorded = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect(recorded["source"] as? String == "live")
        let exchange = try #require((recorded["exchanges"] as? [[String: Any]])?.first)
        #expect(exchange["status"] as? Int == 200)
        #expect(exchange["body"] as? String == answer)
        #expect((exchange["request"] as? [String: Any])?["instructions"] as? String == "Coach")
        let events = try #require(exchange["events"] as? [[String: Any]]).compactMap(CoachEvent.init(record:))
        #expect(events == [.text("Hi"), .done])
    }

    @Test func cancellingARequestMidStreamStopsItAndEndsItCancelled() async {
        let words = (0..<40).map { "data: {\"type\":\"response.output_text.delta\",\"delta\":\"w\($0) \"}" }
        let answer = (words + ["data: {\"type\":\"response.completed\"}"]).joined(separator: "\n")
        let stub = StubResponses(answers: [(200, answer)], pause: .milliseconds(20))
        let requests = CoachRequests(client: CoachClient(account: Harness(vault: signedIn).account, transport: stub))
        let heard = Heard()
        let (firstText, textArrived) = AsyncStream<Void>.makeStream()
        let request = await requests.start("r1", body: Data(question.utf8)) { event in
            heard.add(event)
            if case .text = event { textArrived.yield() }
        }
        #expect(await requests.inFlight == 1)
        var waiting = firstText.makeAsyncIterator()
        _ = await waiting.next()
        await requests.cancel("r1")
        await request.value

        let events = heard.events
        #expect(events.last == .failed(code: "cancelled", status: nil))
        #expect(events.filter(\.isEnd).count == 1)
        #expect(!events.contains(.done))
        #expect(events.count < words.count)
        #expect(await requests.inFlight == 0)
    }

    @Test func aCancelThatArrivesBeforeItsRequestKeepsTheRequestFromBeingSent() async {
        let stub = StubResponses(answers: [(200, "data: {\"type\":\"response.completed\"}")])
        let requests = CoachRequests(client: CoachClient(account: Harness(vault: signedIn).account, transport: stub))
        await requests.cancel("r2")
        let heard = Heard()
        await requests.start("r2", body: Data(question.utf8)) { heard.add($0) }.value
        #expect(heard.events == [.failed(code: "cancelled", status: nil)])
        #expect(stub.requests.isEmpty)
    }

    @Test func aFinishedRequestIsNoLongerInFlight() async {
        let stub = StubResponses(answers: [(200, "data: {\"type\":\"response.completed\"}")])
        let requests = CoachRequests(client: CoachClient(account: Harness(vault: signedIn).account, transport: stub))
        let heard = Heard()
        await requests.start("r3", body: Data(question.utf8)) { heard.add($0) }.value
        #expect(heard.events == [.done])
        #expect(await requests.inFlight == 0)
    }

    @Test func theStandInStartsOverAfterItsLastAnswer() async throws {
        let stub = try #require(StubResponses(fixture: try JSONSerialization.data(withJSONObject: fixture("coach-best-squat.json"))))
        var statuses: [Int] = []
        for _ in 0..<4 { statuses.append(try await stub.stream(URLRequest(url: OpenAI.responses)).status) }
        #expect(statuses == [200, 200, 200, 200])
        #expect(stub.requests.count == 4)
    }
}
