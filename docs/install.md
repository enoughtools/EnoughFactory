# Install EnoughFactory

EnoughFactory runs on Mac and Linux. Windows is not a current distribution target. Each device needs Git and a running Docker-compatible engine for environments. You supply the agent provider accounts you want to use.

## Desktop builds

Use the published release's architecture and signing information to choose an archive. The [release progress](release-progress.md) records which artifacts and platform journeys have actually been verified; source availability does not imply that every native archive has been published.

On Mac, open the DMG and drag EnoughFactory into Applications, or extract the app ZIP. On Linux, make the AppImage executable and open it, or extract the tar archive and run its application executable. Keep the archive's `resources` directory with the application. Linux AppImages can require the distribution's FUSE compatibility package; `--appimage-extract` is available when that package is unavailable.

Packaged applications carry their Node runtime and self-contained envmux executable. They do not need a Node or .NET SDK. Docker Desktop or Colima/Lima is suitable on Mac; Docker Engine is suitable on Linux. Start that engine before opening an environment. EnoughFactory does not automatically install or start it.

## Build and open from source

Install Node 22.14+, pnpm 10.34.5 and the .NET 10 SDK, then run:

```sh
git clone https://github.com/enoughtools/EnoughFactory.git
cd EnoughFactory
pnpm install --frozen-lockfile
pnpm --filter @enoughfactory/envmux build:engine
pnpm build
pnpm desktop
```

The engine build targets your current OS and architecture. If your SDK is outside `PATH`, set `ENOUGHFACTORY_DOTNET` to its executable. `ENOUGHFACTORY_ENVMUX_BINARY` can select an already-built engine. See [desktop distribution](desktop-distribution.md) for native release builds.

## Your first environment

1. Open EnoughFactory and use **Add project** to select a local Git repository.
2. Open project settings to inspect or edit `.envmux.json`. Enough validates the configuration; environment changes apply to the next session.
3. Choose **Start environment**, give it a name, and follow preparation in Activity.
4. Once ready, use services, logs, Terminal, Preview and Changes in the same workspace. Each terminal tab has an independent reconnectable identity.
5. Explicitly stop the environment when you want envmux to harvest its Git changes. Closing the desktop window detaches the interface and leaves the service and environment running.

Your original repository and recovered branches remain ordinary Git. Inspect Changes and the resulting envmux branch before deleting work you want to retain.

## Connect an agent

Open the environment's chat workspace, select Codex, Antigravity or Claude, and choose **Prepare agent**. This installs the pinned runtime in the selected container. You can use the provider account connected on the owning device or enter a provider API key. The key goes to that container and is omitted from chat history. Provider sign-in can also happen in its terminal.

Antigravity's SDK uses Gemini/Vertex credentials. Signing into the Antigravity IDE or CLI alone does not authenticate SDK inference. Codex and Claude account/API access also remain governed by the provider; EnoughFactory does not supply model access.

Choose approval policy in project settings. **Approve all** runs full-access work immediately. **Rules** evaluates the adapter's typed requests and sends unresolved choices to the inbox. **Ask me** requests a decision for the typed requests the runtime exposes. All modes preserve full container access. Claude's current headless route and Antigravity's CLI route support Approve all; selective decisions require a compatible bidirectional adapter. Runtime readiness in Settings reports actual capabilities.

## Create a factory goal

Choose **New goal**, describe the complete outcome, and add completion criteria if you have specific ones. Choose the agent, concurrency, autonomy and approval policy independently.

**Autonomous** keeps planning, executing, checking, repairing and evaluating after individual agent turns finish. **Assisted** prepares work for you to start. **Manual** leaves the next action with you. Decisions and evidence stay attached to the goal. Pause, resume or cancel from the goal workspace; unknown remote execution remains visible until reconciled.

## Pair another device

Configure your signaling endpoint in **Settings → Device connectivity** on the inviting device. Use a service you control; [self-hosting](self-hosting.md) provides Docker, TLS and optional TURN setup.

Open **Devices → Pair a device → Generate invitation**, then paste it into EnoughFactory on the other device within ten minutes. An invitation is single-use and enrolls access to the inviting device. Both services remain online for live access. Offline devices retain ownership labels and last-seen state; their chats return when they reconnect.

## Browser access

The desktop connects automatically. A browser can connect to an installed local service at `http://127.0.0.1:4317` using the token in `~/.enoughfactory/connection.json`, or enroll its own identity using the **connect directly over WebRTC** option and a device invitation. Treat the local token as a private service credential; never put it in a public issue or website configuration.

For local web development, `pnpm dev` serves the interface at `http://127.0.0.1:4318`; paste the same local service token into its connection form. Browser identities and preferences belong to that browser profile. Device conversations remain on the device.

Standalone browser previews require an explicitly configured HTTPS preview gateway. The Electron session browser preserves container-localhost behavior directly. See [self-hosting previews](self-hosting.md#browser-preview-gateway) for the browser route and its limits.

## Keep a device available after login

The desktop starts the device service on demand. To start it at login independently of opening the app, install the optional user service. On Mac, after placing the app in Applications:

```sh
"/Applications/EnoughFactory.app/Contents/Resources/runtime/node" \
  "/Applications/EnoughFactory.app/Contents/Resources/install/install-device-service.mjs" \
  --resources "/Applications/EnoughFactory.app/Contents/Resources"
```

On Linux, from an extracted app archive:

```sh
FACTORY_RESOURCES="$PWD/resources"
"$FACTORY_RESOURCES/runtime/node" \
  "$FACTORY_RESOURCES/install/install-device-service.mjs" \
  --resources "$FACTORY_RESOURCES"
```

For an AppImage, extract it first and use its `squashfs-root/resources` directory. The installer copies stable resources into your user account and enables launchd on Mac or systemd user startup on Linux. Re-run it after upgrading the application. It retains existing state and port settings unless you explicitly change them. See [distribution instructions](desktop-distribution.md) for custom paths, logs and Linux lingering.

## Remove a user service

Use the stable installation's bundled uninstaller:

```sh
# Mac
FACTORY_SERVICE="$HOME/Library/Application Support/EnoughFactory/service"
# Linux instead: FACTORY_SERVICE="$HOME/.local/lib/enoughfactory/service"
"$FACTORY_SERVICE/runtime/node" \
  "$FACTORY_SERVICE/install/uninstall-device-service.mjs"
```

This removes startup and copied resources while preserving state. Add `--purge` only to remove the state directory too. Stop goals and explicitly stop environments before removal; uninstalling the service is not a request to discard or harvest every Docker session. Removing the desktop app does not remove the optional user service automatically.

## Local state and recovery

`ENOUGHFACTORY_HOME` selects the state directory; the default is `~/.enoughfactory`. It holds a private SQLite database, event history, device keys, connection settings, workspace artifacts and logs. A custom state path must be shared by the desktop and its installed service.

Back up the state directory only after shutting down its device service so the SQLite database and journal remain consistent. Back up project repositories separately. Never synchronize a live database across devices or start two coordinators against the same state directory. After a restart, environments reattach where supported; interrupted provider turns need supported conversation resume, and uncertain worker attempts are reconciled before replacement.
