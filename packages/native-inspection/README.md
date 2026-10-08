# Native inspection

EnoughFactory-owned native automation using public Apple APIs. The independent device service owns authority, jobs and GUI leases; this package launches exact products, returns actual app screenshots and bounded interface observations, and acts only on fresh session references.

`NativeInspectionBackend` exposes `readiness`, `requestMacPermissions`, `start`, `observe`, `act`, `restart`, `stop`, `discover` and stop-only `recoverStop`. Product inputs come from the trusted build/fixture coordinator. Original app inventory hashes, original artifact identity and exact source provenance are checked separately. A verified fixture profile is required: changing `HOME` alone does not isolate an arbitrary native application.

The Mac helper is a bundled AppKit application with stable identifier `tools.enough.factory.native-inspection`. It creates a new instance of the exact requested `.app`, binds AX elements to its PID and bundle path, captures only that application's window, and uses app-targeted press/text actions. Keyboard and scrolling additionally require the owned app to remain foreground in an unlocked desktop session. Secure text values are redacted. Input invalidates all references; observe again to verify the outcome. OS Accessibility and screen capture readiness are probed by the actual helper. An explicit setup action can request permissions; an approval policy cannot grant them.

The [iOS runner](native/ios/README.md) is an interactive standalone XCUITest bundle. The backend creates a new owned simulator, installs the exact app and verifies every original file byte, starts the generic runner and exchanges runtime-selected commands through authenticated loopback transport. No fixed mail flow or success assertion is embedded in the runner. Screenshot bytes are retained as PNG files for the service to ingest and return as actual images to the author.

Build and package:

```sh
pnpm --filter @enoughfactory/native-inspection build:mac
pnpm --filter @enoughfactory/native-inspection build:ios
node packages/native-inspection/native/package-assets.mjs /owned/resources/runtime/native-inspection
```

The Mac helper is universal arm64/x86_64. Release builds must supply `ENOUGH_NATIVE_SIGNING_IDENTITY` with the stable release signing identity; the local fallback is explicitly ad-hoc signing and does not promise persistent privacy permissions. Keep the bundle identifier and designated signing identity stable across updates. The iOS runner uses the owning Mac's installed Xcode test runtime; no proprietary Codex computer-use tool or copied Xcode frameworks are required. Runner builds are reusable per source/toolchain identity; distribute only Products, not DerivedData.

Installed assets resolve from `ENOUGHFACTORY_NATIVE_ASSETS`, or `ENOUGHFACTORY_RESOURCES/runtime/native-inspection`. Explicit `ENOUGHFACTORY_NATIVE_MAC_HELPER` and `ENOUGHFACTORY_NATIVE_IOS_XCTESTRUN` override these paths. Development resolves the local package builds. Mac desktop packaging includes these assets and copies them with durable service resources, independent of the Factory window lifetime.

Both native builders capture their complete source, project and build-script inputs before compilation and record exact successful output inventories afterward. Packaging verifies these build receipts against current source and product bytes, then verifies the relocated copies. A current source hash generated after copying an old binary cannot substitute for a successful build receipt. The packaged manifest includes both receipts and the complete native source-key set; `verifyPackagedNativeInspectionAssets` checks these before rollout.

Session manifests and selected screenshots/action journals are durable outputs. Private iOS configuration and `.xctestrun` files contain session credentials and must never be exported as evidence. The service should ingest useful image/journal bytes into ArtifactStore, then retire owned scratch. `stop` removes only the simulator created for that session. `discover` reports previously active sessions as unknown after restart; callers must reconcile their resources before replacing them. A timeout or lost transport does not prove an input failed, and a performed click does not prove a workflow passed.

`restart` confirms the original application exited, relaunches the exact same product with the same fixture RUN, and preserves its data. After service restart, `recoverStop` validates immutable product and launch ownership receipts before stopping a known resource; it does not reattach it for input. Mac recovery uses PID plus application launch timestamp/path/bundle. iOS recovery validates its exclusive Simulator marker and original installed bytes, and fences the separately owned runner by PID, process group, UTC start time and command hash. The runner birth timestamp from `ps` has second precision; this is conservative ownership fencing, not an atomic kernel process handle. Missing, mismatched, corrupt or interrupted Mac restart ownership remains unknown. Historical input outcomes are never promoted by cleanup.
