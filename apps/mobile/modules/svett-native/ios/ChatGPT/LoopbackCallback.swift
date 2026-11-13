import Foundation
import Network

/// A small HTTP listener on 127.0.0.1 that waits for the browser to come back from the sign-in page.
/// OpenAI sends the browser to `http://127.0.0.1:<port>/auth/callback` and to no other kind of
/// address, so the app has to be at that address to see the answer.
final class LoopbackCallback: @unchecked Sendable {
    enum Reply: Sendable {
        /// Sends the browser on to another address. An in-app sign-in sheet closes when that address
        /// has its callback scheme.
        case redirect(URL)
        /// Shows a line of text. Safari has nowhere to go on to, so the text sends the user back to the app.
        case page(String)
    }

    /// The port the system chose.
    let port: UInt16
    private let listener: NWListener
    private let unanswered: Unanswered

    private static let queue = DispatchQueue(label: "LoopbackCallback")
    private static let longestRequest = 65_536
    /// A browser sends its request at once. Anything slower is not a browser.
    private static let requestTimeLimit: DispatchTimeInterval = .seconds(10)

    /// The connections whose request has not arrived yet. Another app on the phone can open one and
    /// send nothing, so they are dropped when the listener stops or the time limit passes. A
    /// connection that is being answered is left alone, or the browser would lose its reply.
    /// Touched only on `queue`.
    private final class Unanswered: @unchecked Sendable {
        var connections: [ObjectIdentifier: NWConnection] = [:]
    }

    private init(listener: NWListener, port: UInt16, unanswered: Unanswered) {
        self.listener = listener
        self.port = port
        self.unanswered = unanswered
    }

    /// Starts listening. `received` gets the path and query of every request for the callback path,
    /// before the browser gets its reply.
    static func start(reply: Reply, received: @escaping @Sendable (String) -> Void) async throws -> LoopbackCallback {
        let parameters = NWParameters.tcp
        // Bound to the loopback address, so nothing on the network can reach the listener.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let unanswered = Unanswered()
        listener.newConnectionHandler = { connection in
            let id = ObjectIdentifier(connection)
            unanswered.connections[id] = connection
            queue.asyncAfter(deadline: .now() + requestTimeLimit) {
                // The identifier of a finished connection can be given to a newer one.
                guard unanswered.connections[id] === connection else { return }
                unanswered.connections[id] = nil
                connection.cancel()
            }
            connection.start(queue: queue)
            read(connection, Data(), unanswered, reply: reply, received: received)
        }
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                let result: Result<LoopbackCallback, any Error>
                switch state {
                case .ready:
                    guard let port = listener.port?.rawValue else { return }
                    result = .success(LoopbackCallback(listener: listener, port: port, unanswered: unanswered))
                case .failed(let error), .waiting(let error):
                    listener.cancel()
                    result = .failure(error)
                case .cancelled:
                    result = .failure(CancellationError())
                default:
                    return
                }
                listener.stateUpdateHandler = nil
                continuation.resume(with: result)
            }
            listener.start(queue: queue)
        }
    }

    func stop() {
        listener.cancel()
        Self.queue.async { [unanswered] in
            for connection in unanswered.connections.values { connection.cancel() }
            unanswered.connections = [:]
        }
    }

    private static func read(_ connection: NWConnection, _ buffered: Data, _ unanswered: Unanswered, reply: Reply,
                             received: @escaping @Sendable (String) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, isComplete, error in
            // Dropped by `stop` or by the time limit while this read was out.
            guard unanswered.connections[ObjectIdentifier(connection)] != nil else { return }
            let buffered = buffered + (data ?? Data())
            // The reply waits for the end of the headers. Closing with part of the request unread
            // can reset the connection before the browser has the reply.
            if let head = buffered.range(of: Data("\r\n\r\n".utf8)) {
                unanswered.connections[ObjectIdentifier(connection)] = nil
                let request = String(decoding: buffered[..<head.lowerBound], as: UTF8.self)
                let target = callbackTarget(ofRequest: request)
                if let target { received(target) }
                let answer = Data((target == nil ? notFound : response(reply)).utf8)
                connection.send(content: answer, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
                    close(connection)
                })
            } else if error != nil || isComplete || buffered.count > longestRequest {
                unanswered.connections[ObjectIdentifier(connection)] = nil
                connection.cancel()
            } else {
                read(connection, buffered, unanswered, reply: reply, received: received)
            }
        }
    }

    /// Lets the browser close first. A connection dropped the moment the reply is written can
    /// reach the browser as a reset, with the reply lost.
    private static func close(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { _, _, isComplete, error in
            if isComplete || error != nil {
                connection.cancel()
            } else {
                close(connection)
            }
        }
        queue.asyncAfter(deadline: .now() + 2) { connection.cancel() }
    }

    /// The path and query of a GET for the callback path, or nil for any other request.
    private static func callbackTarget(ofRequest request: String) -> String? {
        let line = (request.split(whereSeparator: \.isNewline).first ?? "").split(separator: " ")
        guard line.count == 3, line[0] == "GET", URLComponents(string: String(line[1]))?.path == SignInAttempt.callbackPath
        else { return nil }
        return String(line[1])
    }

    private static let notFound = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

    private static func response(_ reply: Reply) -> String {
        switch reply {
        case .redirect(let url):
            return "HTTP/1.1 302 Found\r\nLocation: \(url.absoluteString)\r\nCache-Control: no-store\r\n"
                + "Content-Length: 0\r\nConnection: close\r\n\r\n"
        case .page(let text):
            let page = """
                <!doctype html><html><head><meta charset="utf-8">\
                <meta name="viewport" content="width=device-width, initial-scale=1"><title>svett</title></head>\
                <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;\
                background:#000;color:#fff;font:600 22px -apple-system,sans-serif;text-align:center">\
                <p style="margin:24px">\(text)</p></body></html>
                """
            return "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
                + "Content-Length: \(page.utf8.count)\r\nConnection: close\r\n\r\n" + page
        }
    }
}
