# EnoughFactory desktop and device service distribution

EnoughFactory ships the React workbench in Electron, a separate device service, a pinned native envmux engine, Node 22.22.0 and its own private container runtime. Opening the application does not require a Node or .NET SDK or an existing Docker installation. Required release targets are Apple Silicon Mac and Linux x64/ARM64. Intel Mac is supported by the runtime and packaging configuration. Windows is not currently a release target.

The device service owns sessions and continues after the desktop window closes. The desktop can start it on demand. Install the user startup service below when this device should be available after login without opening the desktop first. Startup service installation uses the current user's account; it does not require or create a system service.

## Bundled container runtime

On Mac, EnoughFactory bundles Lima 2.2.1, Docker 29.8.2 and a verified Ubuntu 24.04 guest image from the 2026-09-26 release. Apple Virtualization supplies the private Linux VM. First start prepares the VM from the bundled image; it does not download or install an operating system. Subsequent agent/container images and provider connections can require network access. Agent sign-in remains a separate onboarding step.

On Linux, EnoughFactory bundles Docker 29.8.2 and its rootless runtime tools. It starts an engine under your normal user account, with a private socket and data directory. Containers retain root access inside their namespaces. The host needs subordinate user/group ID ranges and standard namespace/network utilities: `newuidmap`, `newgidmap`, `iptables`, `nsenter` and `sysctl`. On Debian/Ubuntu these are provided by `uidmap iptables util-linux procps`; Fedora uses `shadow-utils iptables util-linux procps-ng`. The app reports missing host setup, disabled user namespaces or an AppArmor restriction. Install these host prerequisites and configure non-overlapping subordinate ID ranges as the host administrator; running the device service as root does not replace rootless setup.

The runtime uses EnoughFactory's own sockets, ownership labels and state. It does not select a user Docker context, operate Docker Desktop/Colima, or stop a system Docker service. Closing the desktop or shutting down the device service leaves the private engine running. Runtime start/stop and Mac CPU, memory and disk settings are available in the app.

Mac VM disks normally live under `~/.enoughfactory/container/lima`; Linux engine images, volumes and runtime state live under `~/.enoughfactory/docker`. A custom `ENOUGHFACTORY_HOME` selects the device state directory. When a Mac state path exceeds Unix socket limits, its private VM uses an owned directory under `/Users/Shared/.enoughfactory-runtime-<uid>-<stateHash>/lima`; the location is recorded in `container/runtime-location.json`. Default updates/removal preserve this storage as well. Explicit purge removes it only after authenticated stopped-state and directory-ownership checks.

Linux desktop bundles require a graphical desktop and the system libraries required by Electron. An AppImage may require the distribution's FUSE compatibility package; its extraction option is available when FUSE is unavailable. The headless device service itself does not require a display server.

## Open a desktop build

On Mac, open the DMG and drag EnoughFactory into Applications. The ZIP distribution contains the same application. On Linux, make the AppImage executable and launch it, or extract the tar archive and run the included application executable. Keep the archive's `resources` directory beside its executable.

Release filenames include version, platform and architecture, for example `EnoughFactory-0.1.1-mac-arm64.dmg` and `EnoughFactory-0.1.1-linux-x64.AppImage`. Select the archive matching your device. Mac packaging is unsigned unless release signing credentials have been configured. Unsigned builds are labeled as such in the release manifest; macOS can ask for confirmation when opening them. Signing/notarization status must not be inferred from a successful packaging command.

### Ubuntu desktop namespace setup

Ubuntu 24.04 and newer can restrict the user namespaces used by Electron's Chromium sandbox. On affected hosts, keep the extracted application in a stable directory. For an AppImage, run `./EnoughFactory-0.1.1-linux-x64.AppImage --appimage-extract` (use your architecture's filename), then keep the resulting `squashfs-root` directory where you intend to launch it. A tar archive already supplies an extracted application.

Set `FACTORY_APP` to the absolute directory containing `enoughfactory` and `resources`. The host administrator can install the bundled profile for that exact executable:

```sh
FACTORY_APP="/absolute/path/to/extracted/application"
sudo "$FACTORY_APP/resources/runtime/node" \
  "$FACTORY_APP/resources/install/configure-linux-desktop-sandbox.mjs" \
  --executable "$FACTORY_APP/enoughfactory"
"$FACTORY_APP/enoughfactory"
```

The helper verifies the installed bundle and loads one AppArmor profile for its executable path. Launch the application as your regular user; its Chromium sandbox remains enabled. If you move the application, run the helper for its new path. The RootlessKit prerequisite for the private container engine is configured separately when the runtime reports it.

## Install the Mac user service

The application contains both the installer and its Node runtime. After placing it in Applications, run:

```sh
"/Applications/EnoughFactory.app/Contents/Resources/runtime/node" \
  "/Applications/EnoughFactory.app/Contents/Resources/install/install-device-service.mjs" \
  --resources "/Applications/EnoughFactory.app/Contents/Resources"
```

This copies service resources into `~/Library/Application Support/EnoughFactory/service`, writes `~/Library/LaunchAgents/com.enoughtools.factory.device.plist` and enables login startup with launchd. It uses `~/.enoughfactory` for state and port 4317 for local connections. Re-run the command after installing an updated app to update the service copy.

An update retains the installed state directory, port and startup location unless you explicitly change those options. Before replacing resources, the installer authenticates the running EnoughFactory service, requests a private runtime stop, verifies it is stopped, and then shuts down the device service. Active goals, chats or environments block the operation; stop them in the app and retry. It does not force-stop work or send an automatic confirmation to discard environments. VM disks, images and volumes remain available after the update. Start the private runtime again from the app when you resume work.

To inspect startup status and logs:

```sh
launchctl print "gui/$(id -u)/com.enoughtools.factory.device"
tail -n 80 ~/.enoughfactory/logs/device.stderr.log
```

The stable service copy allows the service to keep running independently of where the desktop app is stored. Removing the desktop app does not automatically remove this optional user service.

## Install the Linux user service

From an extracted desktop archive, use the bundled runtime and installer. Set `FACTORY_RESOURCES` to that archive's absolute resources path:

```sh
FACTORY_RESOURCES="$PWD/resources"
"$FACTORY_RESOURCES/runtime/node" \
  "$FACTORY_RESOURCES/install/install-device-service.mjs" \
  --resources "$FACTORY_RESOURCES"
```

For an AppImage, extract it first with `./EnoughFactory-<version>-linux-<arch>.AppImage --appimage-extract` and use `FACTORY_RESOURCES="$PWD/squashfs-root/resources"`. The installer copies the required files, so the extracted directory can be removed after successful installation.

This installs into `~/.local/lib/enoughfactory/service`, writes `~/.config/systemd/user/enoughfactory-device.service`, and enables the user's systemd service. State is stored in `~/.enoughfactory` and the default local port is 4317.

```sh
systemctl --user status enoughfactory-device.service
journalctl --user -u enoughfactory-device.service -n 80
```

For an always-on Linux worker that must run after logout, the host administrator can enable systemd user lingering with `loginctl enable-linger <user>`. EnoughFactory does not enable lingering automatically. If the machine has no systemd user manager, use `--no-start` to install stable resources and run `runtime/node device/service.cjs` under the host's existing process manager with the environment in the generated unit.

## Remove a user service

Use the uninstall script from the installed stable service copy. It verifies and stops the owned private runtime, shuts down the device service, removes user startup and removes the copied application resources. By default it preserves VM disks, images, volumes, conversations and project references:

```sh
# Mac
FACTORY_SERVICE="$HOME/Library/Application Support/EnoughFactory/service"
# Linux instead: FACTORY_SERVICE="$HOME/.local/lib/enoughfactory/service"
"$FACTORY_SERVICE/runtime/node" \
  "$FACTORY_SERVICE/install/uninstall-device-service.mjs"
```

Add `--purge` only when you also want to remove the device's state directory, including private VM disks, container images and volumes, chats, goal records, cached candidates and device-local workspace data. Purge runs only after the app has confirmed its runtime stopped. Repositories outside that directory remain independent. Stop active goals, chats and environments before uninstalling; an in-use runtime returns an error and leaves startup, resources and data intact.

If the device service is offline but private runtime state remains, the installer and uninstaller refuse to replace resources or purge data because they cannot prove the engine stopped. Reopen EnoughFactory with the same state directory and retry while its service is online. They do not kill recorded PIDs, run user Docker commands or delete potentially active engine state.

Advanced installation supports `--home`, `--port`, `--service-dir`, `--unit-dir` and `--no-start`. A custom state path must also be supplied to the desktop through `ENOUGHFACTORY_HOME` so it can discover the same connection. Use the matching `--service-dir` when removing a custom installation. `--no-stop` is only for removing a never-started staged installation; it cannot bypass private runtime checks or purge an unverified runtime.

## Build a release

Build from the repository root with the pinned package manager and dependencies installed. Native envmux executables must already be published into `artifacts/envmux/<target>/envmux`, where targets are `osx-arm64`, `osx-x64`, `linux-x64` and `linux-arm64`. Intel Mac packaging is available only after its `osx-x64` engine has also been built.

```sh
node scripts/package-desktop.mjs --platform darwin --arch arm64
node scripts/package-desktop.mjs --platform linux --arch x64
```

The script builds the web/device/desktop packages, prepares resources, then invokes electron-builder with publication disabled. Mac packaging runs on Mac. Native WebRTC assets are fetched for the selected target rather than copied from the build host: `node-datachannel` 0.33.4, `detect-libc` 2.1.2 and the matching `@node-datachannel` binary package. Each archive is checked against its exact pinned SHA-512 integrity and the official npm registry metadata. Linux releases target glibc distributions, not musl. When the packaging host matches the target, preparation loads the isolated bundled module and creates/closes a peer connection. Other targets still need their own packaged runtime check. `--skip-build` uses already-built packages, `--prepare-only` stages resources without calling electron-builder, and `--dir` produces an unpacked application for focused verification.

Node archives come directly from `https://nodejs.org/dist/v22.22.0/`. Packaging checks the archive SHA-256 against both the official HTTPS `SHASUMS256.txt` and the checksum pinned in the packaging script. A changed checksum fails packaging. Cached archives are checked again, not blindly reused. The bundle includes Node's license and a `runtime/provenance.json` with the source URL, target and verified digest.

Container runtime archive and guest-image versions, source URLs and SHA-256 digests are pinned in `runtime/container/pins.json`. Preparation stages the matching target into `resources/runtime/container`, including Docker executables, Linux rootless tools or Mac Lima and `images/guest.img`. Mac's complete guest image is bundled and verified before release. The staged pins, provenance and upstream notices travel with the private runtime; an existing host Docker installation is not used as a packaging or startup fallback.

Resources contain `runtime/node`, the private `runtime/container` engine/VM payload, `device/service.cjs` and its native assets, `envmux/envmux`, the built web app, complete `workspaces` container runtime helpers, the `agents` Antigravity bridge, installers and upstream notices. Agent Python code runs in its container; a host Python installation is not required. The Electron renderer does not run the device service. Missing required runtime or application assets fail packaging rather than producing a partial desktop release.

`bundle-provenance.json` identifies the product version, platform, architecture, Node version and native module integrity pins, and records SHA-256 hashes for every prepared resource. The desktop uses this identity when staging resources into a stable device-service directory. This is required for AppImage builds, whose temporary mount disappears after the desktop exits. The installer retains the same bundle provenance in its stable copy.

## Release verification and notices

For a new or changed private runtime, start its engine and open a real session on each required target, then close/reopen the desktop while the session continues. Confirm a separate user/system Docker engine was untouched. Use a representative factory journey for changed coordination or execution behavior.

A later release can retain the published 0.1.2 private-engine/session evidence only through explicit component qualification. The qualifier authenticates the original public receipt bytes and compares the selected runtime executables, assets, implementation sources and dependency closure with the new package. Added, removed or changed inputs invalidate that reuse. The historical proof keeps its original source, version and verification time; the new qualification binds that proof to the current package and states exactly which behavior it covers.

Every new release still checks its actual installed resources and extracted archive bytes, native Node/WebRTC startup, sandboxed desktop frame and continued authenticated service health. The login-service installation/update/removal and database retention checks run against the new service, as does its changed inspection API smoke check. These fresh records cover current application and service code; inherited engine evidence does not extend to changed code. Published older downloads and their receipts remain unchanged.

The native user-service check runs an isolated installation with its own state directory, port, copied resources and startup definition. It requires a Mac login launchd domain or a Linux systemd user manager and refuses to take over an existing EnoughFactory startup registration or definition:

```sh
node scripts/check-installed-service.mjs \
  --resources "/absolute/path/to/installed/resources" \
  --receipt "/absolute/path/to/user-service-verification.json" \
  --source-commit "<release source commit>"
```

This check verifies native startup, authenticated health/catalog access, the runtime's positive stopped state, safe uninstall, removal of startup and resources, and preservation of device state. It does not start a second VM or substitute for the private engine/session journey. Its JSON receipt binds the result to the bundle manifest hash, source commit and native platform/architecture. Add `--keep-state` to retain the isolated state after a successful check; a failed check always keeps its diagnostics for inspection.

Publish the built archives, their SHA-256 hashes, architecture and actual signing status through the release manifest used by `factory.enoughtools.com`. Never label an archive available before its download URL has been verified. Include `LICENSE`, `THIRD_PARTY_NOTICES.md`, the Node runtime license and the original envmux and EnoughUI notices with the distribution. The Enough application icon is the supplied brand mark; its separate license is included in `apps/desktop/assets/LICENSE`.
