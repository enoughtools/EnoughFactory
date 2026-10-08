import Foundation
import XCTest

private struct ElementFrame: Codable, Equatable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double

    init(_ frame: CGRect) {
        x = Double(frame.minX); y = Double(frame.minY)
        w = Double(frame.width); h = Double(frame.height)
    }

    func approximatelyEquals(_ other: ElementFrame) -> Bool {
        abs(x - other.x) < 0.5 && abs(y - other.y) < 0.5 && abs(w - other.w) < 0.5 && abs(h - other.h) < 0.5
    }

    var isFinite: Bool { x.isFinite && y.isFinite && w.isFinite && h.isFinite }
}

private struct ObservedElement: Codable {
    let id: String
    let type: String
    let identifier: String
    let label: String
    let value: String?
    let enabled: Bool
    // Apple's public snapshots do not expose hittability. Input validates it live.
    var hittable: Bool? = nil
    let frame: ElementFrame
    let actions: [String]
}

private struct Screenshot: Codable {
    let mimeType: String
    let dataBase64: String
    let width: Int
    let height: Int
}

private struct Observation: Codable {
    let observationId: String
    let observedAt: String
    let appState: String
    let screenshot: Screenshot
    let elements: [ObservedElement]
    let truncated: Bool
}

private struct ActionOutcome: Codable {
    let performed: Bool
    let requiresObservation: Bool
    var previousProcessExited: Bool? = nil
}

@MainActor
private struct ElementReference {
    let application: XCUIApplication
    let type: XCUIElement.ElementType
    let identifier: String
    let label: String
    let value: String?
    let frame: ElementFrame

    init(application: XCUIApplication, snapshot: XCUIElementSnapshot) {
        self.application = application
        type = snapshot.elementType
        identifier = snapshot.identifier
        label = snapshot.label
        value = type == .secureTextField ? nil : snapshot.value.map { String(describing: $0) }
        frame = ElementFrame(snapshot.frame)
    }

    private func matches(_ snapshot: XCUIElementSnapshot) -> Bool {
        snapshot.elementType == type && snapshot.identifier == identifier && snapshot.label == label
            && (type == .secureTextField || snapshot.value.map({ String(describing: $0) }) == value)
            && frame.approximatelyEquals(ElementFrame(snapshot.frame))
    }

    func resolve() throws -> XCUIElement {
        let candidates: [XCUIElement]
        if type == .application {
            candidates = [application]
        } else {
            // Snapshot traversal order is not guaranteed to match the query's
            // per-type ordering. Semantic predicates narrow the query; the
            // complete recorded fingerprint disambiguates repeated controls.
            let predicate = NSPredicate(format: "identifier == %@ AND label == %@", identifier, label)
            let query = application.descendants(matching: type).matching(predicate)
            guard query.count <= 8 else {
                throw RunnerFailure(code: "ambiguous-element", message: "Too many controls share this identity; observe a more specific control.")
            }
            candidates = query.allElementsBoundByIndex
            guard candidates.count <= 8 else {
                throw RunnerFailure(code: "ambiguous-element", message: "The matching controls changed during resolution; observe again.")
            }
        }
        var matching: [(XCUIElement, XCUIElementSnapshot)] = []
        for candidate in candidates {
            if let snapshot = try? candidate.snapshot(), matches(snapshot) {
                matching.append((candidate, snapshot))
            }
        }
        guard !matching.isEmpty else {
            throw RunnerFailure(code: "stale-element", message: "The observed element changed; observe the application again.")
        }
        guard matching.count == 1 else {
            throw RunnerFailure(code: "ambiguous-element", message: "Multiple controls match the recorded element; input was not performed.")
        }
        let (element, snapshot) = matching[0]
        guard snapshot.isEnabled, element.isHittable else {
            throw RunnerFailure(code: "element-unavailable", message: "The observed element is no longer enabled and hittable.")
        }
        return element
    }
}

/// A generic interactive transport. The broker selects every operation at runtime.
/// It deliberately has no EnoughMail-specific navigation or passing assertions.
@MainActor
final class NativeInspectionRunner: XCTestCase {
    private var app: XCUIApplication?
    private var observationID: String?
    private var observedAt: Date?
    private var references: [String: ElementReference] = [:]

    func testInteractiveSession() async throws {
        let configuration = try RunnerConfiguration(environment: ProcessInfo.processInfo.environment)
        executionTimeAllowance = configuration.maximumDuration + 30
        continueAfterFailure = false
        let client = BrokerClient(configuration: configuration)
        let application = XCUIApplication(bundleIdentifier: configuration.bundleIdentifier)
        application.launchArguments = configuration.launchArguments
        application.launchEnvironment = configuration.launchEnvironment
        app = application
        application.launch()
        try requireForeground(application)
        defer { invalidateObservation(); application.terminate(); app = nil }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let ready = try JSONSerialization.data(withJSONObject: [
            "runnerProtocolVersion": 1,
            "sessionId": configuration.sessionID,
            "bundleIdentifier": configuration.bundleIdentifier,
            "runnerPid": ProcessInfo.processInfo.processIdentifier,
            "startedAt": ISO8601DateFormatter().string(from: Date()),
        ], options: [.sortedKeys])
        try await client.post(path: "v1/ready", body: ready)

        let deadline = Date().addingTimeInterval(configuration.maximumDuration)
        var commandFingerprints: [String: Data] = [:]
        var cachedResults: [String: Data] = [:]
        var cachedOrder: [String] = []
        var cachedBytes = 0
        var consecutiveTransportFailures = 0
        var shouldStop = false
        while Date() < deadline && !shouldStop {
            let data: Data
            let status: Int
            do {
                (data, status) = try await client.request(path: "v1/command")
                consecutiveTransportFailures = 0
            } catch {
                consecutiveTransportFailures += 1
                guard consecutiveTransportFailures < 3 else {
                    throw RunnerFailure(code: "broker-disconnected", message: "Broker connection was lost; reconcile this session before replacing it.")
                }
                try await Task.sleep(nanoseconds: 250_000_000)
                continue
            }
            if status == 204 {
                try await Task.sleep(nanoseconds: 150_000_000)
                continue
            }
            guard status == 200, data.count <= 65_536 else {
                throw RunnerFailure(code: "broker-protocol", message: "Broker command response was invalid or oversized.")
            }
            let command = try JSONDecoder().decode(RunnerCommand.self, from: data)
            let fingerprint = try encoder.encode(command)
            let result: Data
            if let priorFingerprint = commandFingerprints[command.id] {
                if priorFingerprint != fingerprint {
                    result = try encoder.encode(RunnerResult<EmptyResult>(id: command.id, sessionId: configuration.sessionID, ok: false,
                        error: RunnerFailure(code: "command-conflict", message: "A completed command identity was reused with different arguments.")))
                } else if let priorResult = cachedResults[command.id] {
                    result = priorResult
                } else {
                    result = try encoder.encode(RunnerResult<EmptyResult>(id: command.id, sessionId: configuration.sessionID, ok: false,
                        error: RunnerFailure(code: "result-expired", message: "Command already ran; its result must be read from the broker journal.")))
                }
            } else {
                guard commandFingerprints.count < 1_000 else {
                    throw RunnerFailure(code: "session-limit", message: "Session command limit reached; stop and open a new owned session.")
                }
                // Reserve before performing input. A transport retry cannot repeat an effect.
                commandFingerprints[command.id] = fingerprint
                do {
                    try command.validate(sessionID: configuration.sessionID)
                    if command.action.kind == .observe {
                        let observation = try observe(application)
                        result = try encoder.encode(RunnerResult(id: command.id, sessionId: configuration.sessionID, ok: true, value: observation))
                    } else {
                        let outcome = try perform(command.action, application: application)
                        shouldStop = command.action.kind == .stop
                        result = try encoder.encode(RunnerResult(id: command.id, sessionId: configuration.sessionID, ok: true,
                            value: outcome))
                    }
                } catch let error as RunnerFailure {
                    result = try encoder.encode(RunnerResult<EmptyResult>(id: command.id, sessionId: configuration.sessionID, ok: false, error: error))
                } catch {
                    result = try encoder.encode(RunnerResult<EmptyResult>(id: command.id, sessionId: configuration.sessionID, ok: false,
                        error: RunnerFailure(code: "runner-error", message: "The runner could not complete this command.")))
                }
                cachedResults[command.id] = result
                cachedOrder.append(command.id)
                cachedBytes += result.count
                while cachedOrder.count > 8 || cachedBytes > 24 * 1_024 * 1_024 {
                    let oldID = cachedOrder.removeFirst()
                    cachedBytes -= cachedResults.removeValue(forKey: oldID)?.count ?? 0
                }
            }
            // Retry only delivery. Never poll another input until this outcome is acknowledged.
            var delivered = false
            for _ in 0..<3 {
                do {
                    try await client.post(path: "v1/result", body: result)
                    delivered = true
                    break
                } catch {
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
            }
            guard delivered else {
                throw RunnerFailure(code: "result-unacknowledged", message: "Command outcome could not be delivered; do not replay its input.")
            }
        }
        guard shouldStop else {
            throw RunnerFailure(code: "session-expired", message: "The native inspection session reached its declared duration.")
        }
    }

    private func requireForeground(_ application: XCUIApplication) throws {
        guard application.state == .runningForeground else {
            invalidateObservation()
            throw RunnerFailure(code: "app-not-foreground", message: "The owned application is no longer foreground; input is paused.")
        }
    }

    private func invalidateObservation() {
        observationID = nil
        observedAt = nil
        references.removeAll(keepingCapacity: true)
    }

    private func observe(_ application: XCUIApplication) throws -> Observation {
        invalidateObservation()
        try requireForeground(application)
        let id = UUID().uuidString.lowercased()
        // All attributes below come from one immutable public accessibility
        // snapshot. Querying each XCUIElement property independently took 61s
        // for 98 elements in the pilot and also mixed different UI snapshots.
        let root = try application.snapshot()
        let maxElements = 350
        let maxTraversal = 5_000
        var snapshots: [(XCUIElementSnapshot, Int, Int)] = [(root, 0, 0)]
        var stack = Array(root.children.reversed())
        while let snapshot = stack.popLast(), snapshots.count < maxTraversal {
            let visible = snapshot.frame.intersects(root.frame) && !snapshot.frame.isEmpty
            let rank = visible ? (actionHints(snapshot.elementType).isEmpty ? 2 : 1) : 3
            snapshots.append((snapshot, snapshots.count, rank))
            stack.append(contentsOf: snapshot.children.reversed())
        }
        // Prioritize visible actionable controls when a large screen must be
        // truncated. IDs retain snapshot traversal identity, not output order.
        snapshots.sort { left, right in
            left.2 == right.2 ? left.1 < right.1 : left.2 < right.2
        }
        var elements: [ObservedElement] = []
        for (snapshot, index, _) in snapshots.prefix(maxElements) {
            // A query is a lazy reference. Resolve exactly one snapshot only
            // when this element is selected for input, then check its complete
            // observed fingerprint before checking live hittability.
            let reference = ElementReference(application: application, snapshot: snapshot)
            guard reference.frame.isFinite else { continue }
            let elementID = "e\(index)"
            references[elementID] = reference
            elements.append(ObservedElement(id: elementID, type: elementTypeName(reference.type),
                identifier: String(reference.identifier.prefix(2_048)), label: String(reference.label.prefix(2_048)),
                value: reference.type == .secureTextField ? "<redacted>" : reference.value.map { String($0.prefix(8_192)) },
                enabled: snapshot.isEnabled, frame: reference.frame, actions: actionHints(reference.type)))
        }
        let screenshot = application.screenshot()
        let png = screenshot.pngRepresentation
        guard png.count <= 8 * 1_024 * 1_024 else {
            invalidateObservation()
            throw RunnerFailure(code: "screenshot-too-large", message: "Application screenshot exceeds the runner image limit.")
        }
        try requireForeground(application)
        let capturedAt = Date()
        observationID = id
        observedAt = capturedAt
        return Observation(observationId: id, observedAt: ISO8601DateFormatter().string(from: capturedAt), appState: "runningForeground",
            screenshot: Screenshot(mimeType: "image/png", dataBase64: png.base64EncodedString(),
                width: Int(screenshot.image.size.width * screenshot.image.scale), height: Int(screenshot.image.size.height * screenshot.image.scale)),
            elements: elements, truncated: snapshots.count > maxElements || !stack.isEmpty)
    }

    private func actionHints(_ type: XCUIElement.ElementType) -> [String] {
        switch type {
        case .textField, .secureTextField, .textView, .searchField: return ["click", "type"]
        case .application, .scrollView, .table, .collectionView: return ["scroll"]
        case .button, .cell, .link, .switch, .key, .menuItem, .pickerWheel, .slider: return ["click"]
        default: return []
        }
    }

    private func perform(_ action: RunnerAction, application: XCUIApplication) throws -> ActionOutcome {
        if action.kind == .stop { invalidateObservation(); return ActionOutcome(performed: true, requiresObservation: false) }
        try requireForeground(application)
        guard action.observationId == observationID, let observedAt,
              Date().timeIntervalSince(observedAt) <= 60 else {
            throw RunnerFailure(code: "stale-observation", message: "Input requires an observation from this session within the last 60 seconds.")
        }
        var reference: ElementReference?
        var selectedElement: XCUIElement?
        if let elementID = action.elementId {
            guard let found = references[elementID] else {
                throw RunnerFailure(code: "unknown-element", message: "Element identity was not present in this observation.")
            }
            selectedElement = try found.resolve()
            reference = found
        }
        if action.kind == .type {
            guard let reference, [.textField, .secureTextField, .textView, .searchField].contains(reference.type) else {
                throw RunnerFailure(code: "not-text-input", message: "Typing requires an observed editable text field or text view.")
            }
        }
        // Input may change the interface even if XCTest reports a later failure.
        invalidateObservation()
        switch action.kind {
        case .click:
            selectedElement!.tap()
        case .type:
            let element = selectedElement!
            element.tap()
            try requireForeground(application)
            if action.mode == "replace" { element.typeKey("a", modifierFlags: .command) }
            if action.mode == "replace" && action.text!.isEmpty {
                // Selecting all and typing an empty string leaves the selected
                // content intact; an explicit delete performs empty replacement.
                element.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
            } else {
                element.typeText(action.text!)
            }
        case .key:
            switch action.key! {
            case "selectAll": application.typeKey("a", modifierFlags: .command)
            case "enter": application.typeKey(XCUIKeyboardKey.return.rawValue, modifierFlags: [])
            case "backspace": application.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
            case "escape": application.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
            case "tab": application.typeKey(XCUIKeyboardKey.tab.rawValue, modifierFlags: [])
            default: preconditionFailure("Validated key")
            }
        case .scroll:
            switch action.direction! {
            case "up": selectedElement!.swipeUp()
            case "down": selectedElement!.swipeDown()
            case "left": selectedElement!.swipeLeft()
            case "right": selectedElement!.swipeRight()
            default: preconditionFailure("Validated direction")
            }
        case .restart:
            // This XCUIApplication belongs to the leased simulator/session.
            // Termination does not remove its data or touch another app/device.
            application.terminate()
            guard application.wait(for: .notRunning, timeout: 10) else {
                throw RunnerFailure(code: "restart-unconfirmed", message: "Previous application exit was not confirmed; no replacement was launched.")
            }
            application.launch()
            try requireForeground(application)
            return ActionOutcome(performed: true, requiresObservation: true, previousProcessExited: true)
        case .observe, .stop:
            preconditionFailure("Non-input command")
        }
        return ActionOutcome(performed: true, requiresObservation: true)
    }

    private func elementTypeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .application: return "application"
        case .button: return "button"
        case .cell: return "cell"
        case .textField: return "textField"
        case .secureTextField: return "secureTextField"
        case .textView: return "textView"
        case .searchField: return "searchField"
        case .staticText: return "staticText"
        case .navigationBar: return "navigationBar"
        case .toolbar: return "toolbar"
        case .scrollView: return "scrollView"
        case .table: return "table"
        case .collectionView: return "collectionView"
        case .switch: return "switch"
        case .tabBar: return "tabBar"
        case .link: return "link"
        case .image: return "image"
        case .window: return "window"
        case .keyboard: return "keyboard"
        case .key: return "key"
        case .menu: return "menu"
        case .menuItem: return "menuItem"
        case .alert: return "alert"
        case .sheet: return "sheet"
        case .picker: return "picker"
        case .pickerWheel: return "pickerWheel"
        case .slider: return "slider"
        case .progressIndicator: return "progressIndicator"
        case .other: return "other"
        default: return "type-\(type.rawValue)"
        }
    }
}
