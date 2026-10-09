import AppKit
import ApplicationServices
import ScreenCaptureKit
import Foundation
import Darwin

struct Failure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw Failure(code: code, message: message) }
func ax(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 1)
    var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func str(_ value: CFTypeRef?) -> String { guard let value else { return "" }; return (value as? String) ?? ((value as? NSNumber)?.stringValue ?? "") }
func frame(_ element: AXUIElement) -> CGRect {
    var point = CGPoint.zero, size = CGSize.zero
    if let p = ax(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID() { AXValueGetValue(p as! AXValue, .cgPoint, &point) }
    if let s = ax(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return CGRect(origin: point, size: size)
}
func elementFingerprint(_ element: AXUIElement) -> String {
    let rect = frame(element)
    return [str(ax(element, kAXRoleAttribute)), str(ax(element, kAXIdentifierAttribute)), str(ax(element, kAXTitleAttribute)), str(ax(element, kAXDescriptionAttribute)), str(ax(element, kAXValueAttribute)), "\(rect.origin.x),\(rect.origin.y),\(rect.width),\(rect.height)"].joined(separator: "|")
}
final class BoundElement { let element: AXUIElement; let fingerprint: String; init(_ element: AXUIElement) { self.element = element; self.fingerprint = elementFingerprint(element) } }
final class Session {
    let id: String; var app: NSRunningApplication; let appPath: String; let output: URL; let launchArguments: [String]
    var observation: String?; var observedAt = Date.distantPast; var elements: [String: BoundElement] = [:]
    init(id: String, app: NSRunningApplication, path: String, output: URL, arguments: [String]) { self.id = id; self.app = app; appPath = path; self.output = output; launchArguments = arguments }
    func invalidate() { observation = nil; elements.removeAll() }
}

@MainActor final class Helper {
    var sessions: [String: Session] = [:]
    func processExists(_ pid: pid_t) throws -> Bool {
        if kill(pid, 0) == 0 { return true }
        if errno == ESRCH { return false }
        try fail("ownership-unknown", "Process existence could not be reconciled.")
    }
    func originalStillRunning(_ app: NSRunningApplication) throws -> Bool {
        if app.isTerminated { return false } // Positive exit state from the retained original application object.
        if try !processExists(app.processIdentifier) { return false }
        guard let expectedBirth = app.launchDate?.timeIntervalSince1970 else { try fail("ownership-unknown", "The owned process launch identity is unavailable.") }
        guard let current = NSRunningApplication(processIdentifier: app.processIdentifier), !current.isTerminated else { try fail("ownership-unknown", "The live process has no verifiable app identity.") }
        guard let birth = current.launchDate?.timeIntervalSince1970 else { try fail("ownership-unknown", "The current process launch identity is unavailable.") }
        if abs(birth - expectedBirth) > 0.001 { return false }
        guard current.bundleURL?.resolvingSymlinksInPath().path == app.bundleURL?.resolvingSymlinksInPath().path,
              current.bundleIdentifier == app.bundleIdentifier else { try fail("ownership-unknown", "The process no longer matches its owned launch identity.") }
        return true
    }
    func terminateOwned(_ app: NSRunningApplication) async throws {
        guard try originalStillRunning(app) else { return }
        _ = app.terminate()
        for _ in 0..<30 { if try !originalStillRunning(app) { return }; try await Task.sleep(nanoseconds: 100_000_000) }
        if try originalStillRunning(app) { _ = app.forceTerminate() }
        for _ in 0..<20 { if try !originalStillRunning(app) { return }; try await Task.sleep(nanoseconds: 100_000_000) }
        guard try !originalStillRunning(app) else { try fail("termination-unknown", "The owned app has not confirmed termination; keep its lease reserved.") }
    }
    func readiness() -> [String: Any] {
        let access = AXIsProcessTrusted(), capture = CGPreflightScreenCaptureAccess()
        let state = CGSessionCopyCurrentDictionary() as? [String: Any]
        let gui = state != nil && (state?["CGSSessionScreenIsLocked"] as? Bool != true)
        var reasons: [String] = []
        if !access { reasons.append("Allow the app named by macOS (normally EnoughFactory) in System Settings > Privacy & Security > App control (Accessibility / Device Control and Data Access).") }
        if !capture { reasons.append("Allow the app named by macOS (normally EnoughFactory) in System Settings > Privacy & Security > Screen & System Audio Recording.") }
        if !gui { reasons.append("Sign in to an unlocked Mac desktop session.") }
        return ["status": reasons.isEmpty ? "ready" : "setup-required", "reasons": reasons, "accessibility": access, "screenCapture": capture, "guiSession": gui, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "protocolVersion": 1]
    }
    func checked(_ id: String) throws -> Session {
        guard let session = sessions[id] else { try fail("session-not-found", "Native session is not owned by this helper.") }
        guard !session.app.isTerminated, session.app.bundleURL?.resolvingSymlinksInPath().path == session.appPath else { session.invalidate(); try fail("process-changed", "The owned application is no longer running from the verified product.") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(AXUIElementCreateApplication(session.app.processIdentifier), &pid) == .success, pid == session.app.processIdentifier else { try fail("process-changed", "The application identity changed.") }
        return session
    }
    func foreground(_ session: Session) throws {
        guard (readiness()["guiSession"] as? Bool) == true else { try fail("session-unavailable", "The Mac desktop session is locked or unavailable.") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == session.app.processIdentifier else { try fail("focus-changed", "The app is no longer in the foreground; observe and resume when its window is usable.") }
    }
    func handle(_ request: [String: Any]) async throws -> [String: Any] {
        let kind = request["kind"] as? String ?? ""
        if kind == "readiness" { return readiness() }
        if kind == "requestPermissions" {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            _ = CGRequestScreenCaptureAccess()
            // Accessibility prompting is asynchronous. Report current access, and
            // only this explicit request may open settings for an outstanding grant.
            let result = readiness()
            let pane = result["accessibility"] as? Bool != true ? "Privacy_Accessibility"
                : result["screenCapture"] as? Bool != true ? "Privacy_ScreenCapture" : nil
            if result["guiSession"] as? Bool == true, let pane,
               let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + pane) {
                _ = NSWorkspace.shared.open(url)
            }
            return result
        }
        // A restarted service may shut down its prior exact process without adopting it for input.
        // This path deliberately does not require Accessibility or an unlocked desktop.
        if kind == "recoverStop" {
            guard let pid = request["pid"] as? Int32, pid > 0,
                  let birth = request["processStartedAt"] as? Double, birth > 0,
                  let path = request["appPath"] as? String,
                  let bundle = request["bundleIdentifier"] as? String else { try fail("ownership-unknown", "The retained Mac launch identity is incomplete.") }
            if try !processExists(pid) { return ["originalProcessExited": true, "alreadyExited": true] }
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { try fail("ownership-unknown", "The live process has no verifiable app identity.") }
            guard let actualBirth = app.launchDate?.timeIntervalSince1970 else { try fail("ownership-unknown", "The process launch identity is unavailable.") }
            if abs(actualBirth - birth) > 0.001 { return ["originalProcessExited": true, "alreadyExited": true, "replacementProcessPresent": true] }
            guard app.bundleURL?.resolvingSymlinksInPath().path == path, app.bundleIdentifier == bundle,
                  app.executableURL?.resolvingSymlinksInPath().path.hasPrefix(path + "/Contents/MacOS/") == true else { try fail("ownership-unknown", "The retained process no longer matches its original app identity.") }
            try await terminateOwned(app)
            return ["originalProcessExited": true, "alreadyExited": false]
        }
        if kind == "start" {
            guard readiness()["status"] as? String == "ready" else { try fail("setup-required", (readiness()["reasons"] as? [String] ?? []).joined(separator: " ")) }
            guard let id = request["sessionId"] as? String, sessions[id] == nil, let path = request["appPath"] as? String, let expected = request["bundleIdentifier"] as? String, let output = request["outputDirectory"] as? String else { try fail("invalid-request", "Missing launch identity.") }
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            guard url.path == path, url.pathExtension == "app", Bundle(url: url)?.bundleIdentifier == expected else { try fail("invalid-product", "Bundle identifier or canonical app path does not match.") }
            let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true; config.activates = true
            config.arguments = request["launchArguments"] as? [String] ?? []
            let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            guard app.bundleURL?.resolvingSymlinksInPath().path == path else { try fail("process-changed", "Launch did not return the exact requested app.") }
            let directory = URL(fileURLWithPath: output); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            sessions[id] = Session(id: id, app: app, path: path, output: directory, arguments: config.arguments)
            var result: [String: Any] = ["pid": app.processIdentifier, "bundleIdentifier": expected, "appPath": path]
            if let birth = app.launchDate?.timeIntervalSince1970 { result["processStartedAt"] = birth }
            return result
        }
        guard let id = request["sessionId"] as? String else { try fail("invalid-request", "Missing session identity.") }
        let session = try checked(id)
        if kind == "stop" || kind == "restart" {
            let previousPid = session.app.processIdentifier
            session.invalidate(); try await terminateOwned(session.app)
            if kind == "stop" { sessions.removeValue(forKey: id); return ["stopped": true] }
            let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true; config.activates = true; config.arguments = session.launchArguments
            let replacement = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: session.appPath), configuration: config)
            guard replacement.bundleURL?.resolvingSymlinksInPath().path == session.appPath, replacement.processIdentifier != previousPid else { try fail("process-changed", "Restart did not launch a new instance of the exact product.") }
            session.app = replacement
            var result: [String: Any] = ["performed": true, "requiresObservation": true, "previousProcessExited": true, "previousPid": previousPid, "pid": replacement.processIdentifier]
            if let birth = replacement.launchDate?.timeIntervalSince1970 { result["processStartedAt"] = birth }
            return result
        }
        if kind == "observe" { return try await observe(session) }
        guard let observation = request["observationId"] as? String, session.observation == observation, Date().timeIntervalSince(session.observedAt) < 60 else { try fail("stale-observation", "Observe the app again before using its interface references.") }
        let bound: BoundElement?
        if kind == "key" { bound = nil }
        else {
            guard let elementId = request["elementId"] as? String, let item = session.elements[elementId], elementFingerprint(item.element) == item.fingerprint else { session.invalidate(); try fail("stale-element", "The observed element changed; observe the app again.") }
            var pid: pid_t = 0
            guard AXUIElementGetPid(item.element, &pid) == .success, pid == session.app.processIdentifier else { session.invalidate(); try fail("process-changed", "Element belongs to a different process.") }
            bound = item
            guard (ax(item.element, kAXEnabledAttribute) as? Bool) != false else { session.invalidate(); try fail("element-unavailable", "The observed element is disabled.") }
        }
        session.invalidate() // Even an uncertain input cannot be repeated with old references.
        if kind == "click", let bound {
            guard AXUIElementPerformAction(bound.element, kAXPressAction as CFString) == .success else { try fail("action-unavailable", "This element does not support app-targeted press.") }
        } else if kind == "type", let bound {
            guard let text = request["text"] as? String, text.utf8.count <= 65536 else { try fail("invalid-request", "Text exceeds the input limit.") }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(bound.element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { try fail("action-unavailable", "The observed element does not support app-targeted text editing.") }
            let value = (request["mode"] as? String == "append" ? str(ax(bound.element, kAXValueAttribute)) : "") + text
            guard AXUIElementSetAttributeValue(bound.element, kAXValueAttribute as CFString, value as CFString) == .success else { try fail("action-unavailable", "The app rejected the text edit.") }
        } else if kind == "key" {
            try foreground(session)
            let key = request["key"] as? String ?? "", codes: [String: CGKeyCode] = ["enter": 36, "backspace": 51, "escape": 53, "tab": 48, "selectAll": 0]
            guard let code = codes[key], let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { try fail("invalid-request", "Unsupported key.") }
            if key == "selectAll" { down.flags = .maskCommand; up.flags = .maskCommand }
            down.postToPid(session.app.processIdentifier); up.postToPid(session.app.processIdentifier)
        } else if kind == "scroll", let bound {
            try foreground(session)
            let direction = request["direction"] as? String ?? "", values = ["up": [3, 0], "down": [-3, 0], "left": [0, 3], "right": [0, -3]]
            guard let delta = values[direction], let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(delta[0]), wheel2: Int32(delta[1]), wheel3: 0) else { try fail("invalid-request", "Unsupported scroll direction.") }
            let rect = frame(bound.element); event.location = CGPoint(x: rect.midX, y: rect.midY)
            event.postToPid(session.app.processIdentifier)
        } else { try fail("invalid-request", "Unsupported native action.") }
        return ["performed": true, "requiresObservation": true]
    }
    func observe(_ session: Session) async throws -> [String: Any] {
        session.invalidate()
        guard readiness()["status"] as? String == "ready" else { try fail("setup-required", "Accessibility and app-window capture permissions are required.") }
        let contents = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let owned = contents.windows.filter { $0.owningApplication?.processID == session.app.processIdentifier && $0.frame.width > 1 && $0.frame.height > 1 }
        guard let window = owned.first(where: { $0.windowLayer == 0 }) ?? owned.first else { try fail("window-unavailable", "The owned app has no capturable window.") }
        let config = SCStreamConfiguration(); config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2); config.showsCursor = false
        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        let image = NSBitmapImageRep(cgImage: cgImage)
        guard let png = image.representation(using: .png, properties: [:]) else { try fail("capture-failed", "App screenshot could not be encoded.") }
        let observation = UUID().uuidString.lowercased(); let path = session.output.appendingPathComponent(observation + ".png")
        try png.write(to: path, options: .atomic)
        let application = AXUIElementCreateApplication(session.app.processIdentifier)
        let windows = (ax(application, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var nodes: [[String: Any]] = [], seen = Set<CFHashCode>(), truncated = false
        func walk(_ element: AXUIElement, _ depth: Int) {
            if nodes.count >= 1200 || depth > 32 { truncated = true; return }
            if !seen.insert(CFHash(element)).inserted { return }
            let key = observation + ":" + String(nodes.count), rect = frame(element), role = str(ax(element, kAXRoleAttribute))
            let secure = str(ax(element, kAXSubroleAttribute)) == kAXSecureTextFieldSubrole
            let label = [str(ax(element, kAXTitleAttribute)), str(ax(element, kAXDescriptionAttribute))].filter { !$0.isEmpty }.joined(separator: " ")
            var actions: CFArray?; AXUIElementCopyActionNames(element, &actions)
            var settable = DarwinBoolean(false); AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
            var supported = (actions as? [String] ?? []).contains(kAXPressAction) ? ["click"] : []
            if settable.boolValue { supported.append("type") }
            nodes.append(["id": key, "type": role, "identifier": str(ax(element, kAXIdentifierAttribute)), "label": String(label.prefix(4096)), "value": secure ? "<redacted>" : String(str(ax(element, kAXValueAttribute)).prefix(4096)), "enabled": (ax(element, kAXEnabledAttribute) as? Bool) ?? true, "hittable": rect.width > 0 && rect.height > 0, "frame": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height], "actions": supported])
            session.elements[key] = BoundElement(element)
            for child in (ax(element, kAXChildrenAttribute) as? [AXUIElement] ?? []) { walk(child, depth + 1) }
        }
        for window in windows { walk(window, 0) }
        session.observation = observation; session.observedAt = Date()
        return ["sessionId": session.id, "observationId": observation, "observedAt": ISO8601DateFormatter().string(from: session.observedAt), "appState": NSWorkspace.shared.frontmostApplication?.processIdentifier == session.app.processIdentifier ? "foreground" : "background", "elements": nodes, "truncated": truncated, "screenshot": ["path": path.path, "mimeType": "image/png", "width": cgImage.width, "height": cgImage.height], "pid": session.app.processIdentifier, "windowId": window.windowID]
    }
}

@main struct Entry {
    static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let helper = Helper()
        DispatchQueue.global().async {
            while let line = readLine() {
                DispatchQueue.main.async {
                    Task { @MainActor in
                        var response: [String: Any] = [:]
                        do {
                            guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("invalid-request", "Expected a JSON object.") }
                            response["id"] = request["id"] ?? NSNull()
                            response["value"] = try await helper.handle(request); response["ok"] = true
                        } catch let error as Failure { response["ok"] = false; response["error"] = ["code": error.code, "message": error.message] }
                        catch { response["ok"] = false; response["error"] = ["code": "native-error", "message": String(describing: error)] }
                        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), var output = String(data: data, encoding: .utf8) { output += "\n"; FileHandle.standardOutput.write(Data(output.utf8)) }
                    }
                }
            }
            DispatchQueue.main.async { app.terminate(nil) }
        }
        app.run()
    }
}
