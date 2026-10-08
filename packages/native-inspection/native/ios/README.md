# iOS Simulator interactive runner

This is an EnoughFactory-owned, generic XCUITest runner. It launches an **already installed** application by bundle identifier and obtains every observation/action command from an authenticated loopback broker at runtime. It contains no prerecorded mail flow and no app-specific success assertion. It neither links nor rebuilds the application under test.

The source uses Apple's public XCTest/XCUIAutomation APIs and Foundation networking. Build it on the owning Mac with the installed Xcode; the Xcode-provided test host/frameworks are toolchain dependencies, not vendored third-party automation. Xcode 27.0 (27A266a), iOS Simulator SDK 27.0, arm64 and x86_64 compilation were verified. Minimum simulator OS is iOS 17. A real interactive run remains necessary before advertising readiness.

## Build without touching a simulator

```sh
sh packages/native-inspection/native/ios/build-runner.sh /owned/cache/ios-inspection-runner
```

The output contains `Build/Products/EnoughNativeInspection_EnoughNativeInspection_iphonesimulator27.0-arm64-x86_64.xctestrun` and `Build/Products/Debug-iphonesimulator/EnoughNativeInspection-Runner.app`. The exact SDK suffix is toolchain-dependent. Cache this runner once per source/toolchain identity; do not archive DerivedData per session. Build products need to remain available until their sessions stop.

## Prepare and start an owned session

The coordinator must first acquire a simulator lease, verify the original app product hashes, create/use only an owned simulator, install that exact app, and verify its declared fixture/data isolation independently. Bundle identity alone does not prove that the installed app is the expected product. This runner does not grant a simulator lease, isolate arbitrary applications, or manufacture fixture isolation evidence.

Write a private JSON file (0600) with:

```json
{
  "sourceXctestrunPath": "/owned/cache/ios-inspection-runner/Build/Products/EnoughNativeInspection_EnoughNativeInspection_iphonesimulator27.0-arm64-x86_64.xctestrun",
  "outputDirectory": "/owned/native-sessions/an-opaque-session-identity",
  "brokerUrl": "http://127.0.0.1:41391",
  "token": "a fresh session-specific secret of at least 32 characters",
  "sessionId": "an-opaque-session-identity",
  "bundleIdentifier": "tools.enough.mail.ios",
  "launchArguments": ["--production-fixture", "an-isolated-run"],
  "launchEnvironment": {},
  "maxDurationSeconds": 900
}
```

Pass the file path, not its token, on the command line. The configuration and generated `.xctestrun` contain a secret and must remain outside source/history/artifact exports.

```sh
node packages/native-inspection/native/ios/prepare-run.mjs PRIVATE_CONFIGURATION.json
xcodebuild test-without-building \
  -xctestrun PRIVATE_SESSION_DIRECTORY/inspection.xctestrun \
  -destination 'platform=iOS Simulator,id=OWNED_DEVICE_UUID' \
  -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  -resultBundlePath PRIVATE_SESSION_DIRECTORY/result.xcresult
```

`prepare-run.mjs` understands the generated v2 plist (and the corresponding single-target v1 shape), injects `TestTargets[].EnvironmentVariables`, preserves original `__TESTROOT__` paths when relocating, and restricts execution to `NativeInspectionRunner/testInteractiveSession`. It never installs an app, boots a device, or starts a test. Do not use `booted`, reset, erase or delete an unrelated simulator.

`XCUIApplication.launch()` terminates an existing instance with the same bundle identifier before launching the configured app. Therefore the coordinator must establish exclusive ownership of the simulator before starting the runner. On stop, expiry, transport failure or test failure, the test terminates the app it launched. XCTest exceptions can terminate a test between input and result delivery; the coordinator must retain an unknown outcome and reconcile, rather than automatically replay an action.

## Broker protocol v1

Every request sends `Authorization: Bearer <session token>` and `X-Enough-Session: <sessionId>`. Only explicit HTTP loopback origins are accepted; redirects are never followed. The host broker must authenticate before returning any command and restrict each connection to its owning session. It must durably journal command identities/results and acknowledge duplicate result delivery idempotently.

* `POST /v1/ready`: `{ runnerProtocolVersion: 1, sessionId, bundleIdentifier, runnerPid, startedAt }`. The PID belongs to the test runner, **not** the app under test. This is launch readiness, not proof of source identity, fixture isolation or workflow success.
* `GET /v1/command`: return 204 when idle, or 200 with `{ id, sessionId, action }`. Requests have a five-second timeout; keep idle polling/long polling bounded accordingly.
* `POST /v1/result`: `{ id, sessionId, ok, value?, error?: { code, message } }`. Acknowledgement is any 2xx response. The runner retries result delivery three times and never repeats the input merely because delivery failed.

Actions:

| Kind | Fields | Behavior |
| --- | --- | --- |
| `observe` | — | Fresh application screenshot and bounded accessibility elements |
| `click` | `observationId`, `elementId` | Tap the identified app element |
| `type` | `observationId`, `elementId`, `text`, optional `mode` | Tap a text input and type; `append` is default, `replace` selects all with Command+A first; empty replacement explicitly deletes the selection |
| `key` | `observationId`, `key`, optional `elementId` | `enter`, `backspace`, `escape`, `tab`, `selectAll`; optional element is revalidated |
| `scroll` | `observationId`, `elementId`, `direction` | Swipe `up`, `down`, `left`, `right` inside the element |
| `restart` | `observationId` | Terminate only the owned app, confirm `notRunning`, relaunch with the same arguments/environment and confirm foreground; preserve fixture data |
| `stop` | — | Acknowledge, end the test, terminate the owned app |

An observation returns `{ observationId, observedAt, appState, screenshot: { mimeType: 'image/png', dataBase64, width, height }, elements, truncated }`. Each element has `{ id, type, identifier, label, value, enabled, frame: { x, y, w, h }, actions }`. Frames are XCTest screen points; image dimensions are pixels. Only elements from one immutable public snapshot of the owned application are returned. `hittable` is omitted because Apple's public snapshot API does not expose it; `actions` are type-based hints, not proof that input will succeed. The selected element's fingerprint and actual hittability are checked immediately before input. Secure text values are redacted; screenshots can still contain sensitive visible information, so default to a verified fixture profile. Screenshots are bounded to 8 MiB; at most 350 elements are returned, prioritizing visible actionable controls if truncated.

Every input requires the latest observation from the current session, no older than 60 seconds. Observing again supersedes earlier references. Before acting, the runner checks foreground app state, resolves elements by type and identifier/label predicates, then disambiguates at most eight candidates using the complete recorded value/frame fingerprint. Missing, changed, ambiguous or overly broad matches fail without input. Snapshot traversal ordinals are not treated as query identities. The selected control must also be enabled and actually hittable. Every attempted input invalidates all references. The caller must observe and assert the resulting state; `{ performed: true, requiresObservation: true }` does not mean the workflow passed. As with all UI automation, validation and input are not an atomic operation with the application's asynchronous state.

An acknowledged `restart` additionally returns `previousProcessExited: true`, after XCTest confirms the owned application reached `notRunning` before relaunch. The same launch configuration and app data remain in place. This is an application restart, not a test-runner replacement, fixture reset or simulator restart. Failure to confirm exit does not launch a replacement; reconcile that outcome before continuing. The caller must take a fresh observation and verify persistence/workflow assertions after relaunch.

Command IDs are at most once within a runner session. Identical redelivery returns the cached result; changed arguments under an existing identity fail. The runner retains eight results within 24 MiB and keeps all command fingerprints (up to 1000). An evicted result returns `result-expired`, never repeats input. After a runner/process restart, use a new session and reconcile the prior journal before continuing.

## Required interactive proof

Before readiness is advertised, exercise the **actual retained EnoughMail product**, selecting actions from each newly returned observation: at least two observe/action cycles in one owned session, a text edit and visible verification, and a deliberately stale observation rejected without input. Record original app inventory hashes, launch/fixture identity, command/result journal, original PNG bytes and assertions. The coordinator must independently verify fixture isolation (for example, through a product-owned run-root marker). Do not present a fixed UI test, runner compilation, screenshot presence or model-written assertion as this proof.
