import Foundation

struct RunnerFailure: Error, Codable {
    let code: String
    let message: String
}

struct RunnerConfiguration {
    let brokerURL: URL
    let token: String
    let sessionID: String
    let bundleIdentifier: String
    let launchArguments: [String]
    let launchEnvironment: [String: String]
    let maximumDuration: TimeInterval

    init(environment: [String: String]) throws {
        func required(_ key: String) throws -> String {
            guard let value = environment[key], !value.isEmpty else {
                throw RunnerFailure(code: "configuration-required", message: "Missing runner configuration: \(key)")
            }
            return value
        }
        let rawURL = try required("ENOUGH_IOS_BROKER_URL")
        guard let url = URL(string: rawURL), url.scheme == "http",
              ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? ""),
              url.port != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw RunnerFailure(code: "invalid-broker", message: "Runner broker must be an explicit loopback HTTP origin.")
        }
        let token = try required("ENOUGH_IOS_BROKER_TOKEN")
        guard token.utf8.count >= 32, token.utf8.count <= 512,
              !token.contains(where: { $0.isWhitespace || $0.isNewline }) else {
            throw RunnerFailure(code: "invalid-token", message: "Runner broker token is invalid.")
        }
        let sessionID = try required("ENOUGH_IOS_SESSION_ID")
        guard Self.validIdentity(sessionID) else {
            throw RunnerFailure(code: "invalid-session", message: "Runner session identity is invalid.")
        }
        let bundleIdentifier = try required("ENOUGH_IOS_AUT_BUNDLE_ID")
        guard bundleIdentifier.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$", options: .regularExpression) != nil else {
            throw RunnerFailure(code: "invalid-app", message: "Application bundle identifier is invalid.")
        }
        let argumentData = Data(try required("ENOUGH_IOS_LAUNCH_ARGUMENTS_JSON").utf8)
        guard argumentData.count <= 32_768,
              let arguments = try? JSONDecoder().decode([String].self, from: argumentData),
              arguments.count <= 128, arguments.allSatisfy({ !$0.contains("\0") }) else {
            throw RunnerFailure(code: "invalid-launch-arguments", message: "Launch arguments must be a bounded JSON string array.")
        }
        let rawLaunchEnvironment = environment["ENOUGH_IOS_LAUNCH_ENVIRONMENT_JSON"] ?? "{}"
        guard rawLaunchEnvironment.utf8.count <= 32_768,
              let launchEnvironment = try? JSONDecoder().decode([String: String].self, from: Data(rawLaunchEnvironment.utf8)),
              launchEnvironment.count <= 128,
              launchEnvironment.allSatisfy({ !$0.key.isEmpty && !$0.key.contains("=") && !$0.key.contains("\0") && !$0.value.contains("\0") }) else {
            throw RunnerFailure(code: "invalid-launch-environment", message: "Launch environment must be a bounded JSON string dictionary.")
        }
        let duration = Double(environment["ENOUGH_IOS_MAX_DURATION_SECONDS"] ?? "900") ?? 0
        guard duration.isFinite, duration >= 10, duration <= 3_600 else {
            throw RunnerFailure(code: "invalid-duration", message: "Session duration must be between 10 and 3600 seconds.")
        }
        self.brokerURL = url
        self.token = token
        self.sessionID = sessionID
        self.bundleIdentifier = bundleIdentifier
        self.launchArguments = arguments
        self.launchEnvironment = launchEnvironment
        self.maximumDuration = duration
    }

    static func validIdentity(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil
    }
}

struct RunnerCommand: Codable {
    let id: String
    let sessionId: String
    let action: RunnerAction

    func validate(sessionID: String) throws {
        guard RunnerConfiguration.validIdentity(id), sessionId == sessionID else {
            throw RunnerFailure(code: "wrong-authority", message: "Command identity does not belong to this session.")
        }
        try action.validate()
    }
}

struct RunnerAction: Codable {
    enum Kind: String, Codable { case observe, click, type, key, scroll, restart, stop }
    let kind: Kind
    var observationId: String?
    var elementId: String?
    var text: String?
    var key: String?
    var direction: String?
    var mode: String?

    func validate() throws {
        if kind != .observe && kind != .stop {
            guard let observationId, RunnerConfiguration.validIdentity(observationId) else {
                throw RunnerFailure(code: "observation-required", message: "Input requires a fresh observation identity.")
            }
        }
        if kind == .click || kind == .type || kind == .scroll {
            guard let elementId, RunnerConfiguration.validIdentity(elementId) else {
                throw RunnerFailure(code: "element-required", message: "This action requires an observed element identity.")
            }
        }
        if kind == .type {
            guard let text, text.utf8.count <= 32_768, !text.contains("\0"),
                  mode == nil || mode == "append" || mode == "replace" else {
                throw RunnerFailure(code: "invalid-text", message: "Text must be bounded and mode must be append or replace.")
            }
        }
        if kind == .key && !["enter", "backspace", "escape", "tab", "selectAll"].contains(key ?? "") {
            throw RunnerFailure(code: "unsupported-key", message: "Supported keys: enter, backspace, escape, tab, selectAll.")
        }
        if kind == .scroll && !["up", "down", "left", "right"].contains(direction ?? "") {
            throw RunnerFailure(code: "unsupported-direction", message: "Supported scroll directions: up, down, left, right.")
        }
    }
}

struct RunnerResult<Value: Encodable>: Encodable {
    let id: String
    let sessionId: String
    let ok: Bool
    var value: Value?
    var error: RunnerFailure?
}

struct EmptyResult: Codable {}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Check before sending, so the session token cannot follow a redirect.
        completionHandler(nil)
    }
}

struct BrokerClient {
    let configuration: RunnerConfiguration
    let session: URLSession

    init(configuration: RunnerConfiguration) {
        self.configuration = configuration
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 5
        sessionConfiguration.timeoutIntervalForResource = 8
        sessionConfiguration.urlCache = nil
        sessionConfiguration.httpCookieStorage = nil
        sessionConfiguration.httpShouldSetCookies = false
        self.session = URLSession(configuration: sessionConfiguration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    func request(path: String, body: Data? = nil) async throws -> (Data, Int) {
        var request = URLRequest(url: configuration.brokerURL.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(configuration.sessionID, forHTTPHeaderField: "X-Enough-Session")
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RunnerFailure(code: "broker-protocol", message: "Broker returned a non-HTTP response.")
        }
        guard response.url?.host == configuration.brokerURL.host,
              response.url?.port == configuration.brokerURL.port,
              response.url?.scheme == configuration.brokerURL.scheme else {
            throw RunnerFailure(code: "broker-redirect", message: "Broker redirects are not permitted.")
        }
        return (data, response.statusCode)
    }

    func post(path: String, body: Data) async throws {
        let (_, status) = try await request(path: path, body: body)
        guard status >= 200 && status < 300 else {
            throw RunnerFailure(code: "broker-rejected", message: "Broker rejected runner result (HTTP \(status)).")
        }
    }
}
