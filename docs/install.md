# Install EnoughFactory

EnoughFactory runs on Mac and Linux. Windows is not a current distribution target. It bundles its own container-runtime tools and owns a private engine, socket and storage on each device. Git must be available for local source operations. You supply repositories and the agent provider accounts you want to use.

## Desktop builds

Use the published release's architecture and signing information to choose an archive. The [release progress](release-progress.md) records which artifacts and platform journeys have actually been verified; source availability does not imply that every native archive has been published.

On Mac, open the DMG and drag EnoughFactory into Applications, or extract the app ZIP. On Linux, make the AppImage executable and open it, or extract the tar archive and run its application executable. Keep the archive's `resources` directory with the application. Linux AppImages can require the distribution's FUSE compatibility package; `--appimage-extract` is available when that package is unavailable.

Packaged applications carry Node, a self-contained envmux executable and the container-runtime tools for their OS. They do not need a Node/.NET SDK or an existing Docker installation. Mac uses a private Lima VM with Apple's virtualization framework; Linux uses a dedicated rootless Docker Engine. The device service starts and recovers this runtime independently of the desktop window. Existing Docker contexts, daemons, images and volumes are separate from EnoughFactory.

On Ubuntu 24.04 and newer, host AppArmor policy can also require permission for Electron's user namespaces. Use a stable extracted tar/AppImage directory and set `FACTORY_APP` to the absolute folder containing `enoughfactory` and `resources`:

```sh
FACTORY_APP="/absolute/path/to/extracted/application"
sudo "$FACTORY_APP/resources/runtime/node" \
  "$FACTORY_APP/resources/install/configure-linux-desktop-sandbox.mjs" \
  --executable "$FACTORY_APP/enoughfactory"
"$FACTORY_APP/enoughfactory"
```

The bundled helper installs a profile scoped to that executable and keeps Chromium's sandbox enabled. Run the application as your regular user. For AppImage extraction and path details, see [Ubuntu desktop namespace setup](desktop-distribution.md#ubuntu-desktop-namespace-setup). The private engine's RootlessKit setup remains a separate runtime prerequisite.

## Prepare the private runtime

Open **Settings → EnoughFactory runtime → Prepare runtime** to start EnoughFactory's engine. It can also start when you open an environment. The app shows preparation, readiness, resource limits and actionable prerequisites. Mac bundles a pinned Ubuntu guest image and prepares a private writable VM disk from it on first start. Allow space for the application, that disk, container images and your workspace data. Container base images and provider tools still need a network connection when first prepared.

Mac CPU and memory allocations can be changed through runtime resource settings after the runtime stops; the disk capacity is shown alongside them. Linux runs directly in its own rootless namespace, with goal concurrency configured separately. Closing the window leaves running work intact. Stopping the runtime with active environments requires **Stop environments & runtime**, which interrupts their tools, waits for source recovery and then stops the engine.

## Linux runtime prerequisites

Run the device service as your regular user. The private rootless engine needs host UID/GID mapping helpers, at least 65,536 subordinate IDs in both `/etc/subuid` and `/etc/subgid`, permitted user namespaces, and a systemd user session with D-Bus and cgroup v2 for enforced resource limits. Containers still have root permissions inside their namespace. [Docker rootless prerequisites](https://docs.docker.com/engine/security/rootless/).

On Debian/Ubuntu, install the host prerequisites:

```sh
sudo apt install uidmap iptables util-linux procps dbus-user-session
```

On Fedora:

```sh
sudo dnf install shadow-utils iptables util-linux procps-ng dbus-daemon
```

These supply host helpers; EnoughFactory supplies its private daemon and client. Inspect the subordinate ranges already assigned to your account:

```sh
getent passwd "$(id -u)"
cat /etc/subuid /etc/subgid
```

If either file lacks a range of at least 65,536 IDs for your account, have the administrator assign a free, non-overlapping range in each file using `usermod --add-subuids START-END --add-subgids START-END USERNAME`. Choose ranges after inspecting existing allocations; do not reuse another account's IDs. Restart the private runtime afterward.

If setup reports that user namespaces are disabled, the host administrator must enable them according to the host policy. Ubuntu 24.04 and newer can additionally require an AppArmor rule for the **actual bundled RootlessKit path** shown by the app. Use the application-specific profile described by [Docker's rootless troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/) rather than disabling AppArmor globally. The runtime keeps its failure details visible until the prerequisite is resolved.

If the user D-Bus session is missing, install the package above and log into an ordinary user session. For a headless device, an administrator can enable its user manager with `sudo loginctl enable-linger "$USER"`, then start the user session/service. EnoughFactory uses the UID-owned user bus and reports unavailable cgroup support; it does not silently discard configured memory limits.

## Build and open from source

Install Node 22.14+, pnpm 10.34.5, Git, the .NET 10 SDK, Python 3.10+ and build tools (`make`, `gperf`, `tar`, `file`, binutils and standard shell utilities; Xcode Command Line Tools on Mac), then run:

```sh
git clone https://github.com/enoughtools/EnoughFactory.git
cd EnoughFactory
pnpm install --frozen-lockfile
pnpm --filter @enoughfactory/envmux build:engine
node scripts/prepare-container-runtime.mjs
pnpm build
pnpm desktop
```

The engine build and runtime preparation target your current OS and architecture. The runtime script downloads pinned archives and Go/Zig toolchains, builds the native engine components, verifies their hashes and prepares `.cache/container-runtime/<platform>-<arch>`. It retains the source/relink companion with the runtime assets and accepts explicit platform, architecture and destination arguments for release assembly.

Mac preparation includes the host CLI, Lima, guest engine and Ubuntu image. The included guest image is verified before creating the VM; first launch does not fetch an operating system.

If your SDK is outside `PATH`, set `ENOUGHFACTORY_DOTNET` to its executable. `ENOUGHFACTORY_ENVMUX_BINARY` can select an already-built engine. See [desktop distribution](desktop-distribution.md) for native release preparation.

## Your first environment

The [status board example](../examples/status-board/README.md) gives you a small working Node app, a cache service, configured checks and a web preview. Copy it into its own Git repository using the example's instructions, then select that repository below. It also includes a representative goal to try after connecting an agent.

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

Choose **New goal**, describe the complete outcome, and add completion criteria if you have specific ones. Choose the agent, concurrency, autonomy and approval policy independently. **Repository workspace** selects Git or ArtifactFS where the runtime supports it; an unavailable mount capability remains visible with the compatible Git route.

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

This removes startup and copied resources while preserving state. Add `--purge` only to remove the state directory too. Stop goals, environments and the private runtime before removal; uninstalling the service is not a request to discard unharvested work. Removing the desktop app does not remove the optional user service automatically.

## Local state and recovery

`ENOUGHFACTORY_HOME` selects the state directory; the default is `~/.enoughfactory`. It holds a private SQLite database, event history, device keys, connection settings, workspace artifacts and logs. Mac's VM normally lives under `container/lima`; Linux keeps its private engine's persistent data and configuration under `docker/data` and `docker/config`. A custom state path must be shared by the desktop and its installed service.

Very long state paths can exceed the operating system's Unix socket limit. Mac then keeps its VM in a private, user-owned directory under `/Users/Shared` and records the actual location in `container/runtime-location.json`. Linux can place its socket in a guarded user runtime or temporary directory while retaining persistent data in the state directory. The runtime status shows its actual data location. Preserve the location record when moving or backing up state; ordinary uninstall retains the runtime and its work.

At startup, the device service checks `factory.sqlite`'s schema version before accepting work. This build supports schema version 1. A new database receives the baseline schema; an older database without version metadata is adopted in one transaction, preserving records, event sequence numbers and history. An existing version 1 database is checked and reopened without replaying the migration. Future migrations apply in version order and commit their schema changes and version marker together; a failed migration rolls back and startup closes the database.

A database with a newer schema version, malformed version metadata or inconsistent tables stops startup with an error. EnoughFactory does not downgrade or reset it. Use a build that supports its version, or restore a known consistent backup after stopping the service. Do not manually change the version marker to force an older build to open it.

Before upgrading, back up the entire state directory after stopping work, its private runtime and the device service so VM/engine storage and the SQLite database remain consistent. Keep `factory.sqlite` and any `factory.sqlite-wal`/`factory.sqlite-shm` files together in the backup, along with device keys, artifacts and runtime-location records. Back up project repositories separately. To restore, stop the service and runtime, preserve the current directory, and restore the backup as a unit using a compatible application build. Never synchronize a live database across devices or start two coordinators against the same state directory. After a restart, environments reattach where supported; interrupted provider turns need supported conversation resume, and uncertain worker attempts are reconciled before replacement.
