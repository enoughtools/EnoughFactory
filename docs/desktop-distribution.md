# EnoughFactory desktop and device service distribution

EnoughFactory ships the React workbench in Electron, a separate device service, a pinned native envmux engine and Node 22.22.0. Opening the application does not require a Node or .NET SDK. Required release targets are Apple Silicon Mac and Linux x64/ARM64. Intel Mac is supported by the runtime and packaging configuration. Windows is not currently a release target.

The device service owns sessions and continues after the desktop window closes. The desktop can start it on demand. Install the user startup service below when this device should be available after login without opening the desktop first. Startup service installation uses the current user's account; it does not require or create a system service.

## Runtime prerequisites

Install a running Docker-compatible engine before starting environments. Docker Engine is suitable on Linux. Docker Desktop or the OSS Colima/Lima route is suitable on Mac. EnoughFactory does not silently install a Docker engine or expose the host Docker socket inside agent containers. Agent credentials remain a separate onboarding step.

The installer captures the current command search path and includes standard Homebrew, Docker and user binary locations for login startup. For a Docker installation in a custom location, include it in `PATH` when running the installer; login services do not inherit an interactive shell's startup scripts. The Docker daemon must also be running when an environment is started.

Linux desktop bundles require a graphical desktop and the system libraries required by Electron. An AppImage may require the distribution's FUSE compatibility package; its extraction option is available when FUSE is unavailable. The headless device service itself does not require a display server.

## Open a desktop build

On Mac, open the DMG and drag EnoughFactory into Applications. The ZIP distribution contains the same application. On Linux, make the AppImage executable and launch it, or extract the tar archive and run the included application executable. Keep the archive's `resources` directory beside its executable.

Release filenames include version, platform and architecture, for example `EnoughFactory-0.1.0-mac-arm64.dmg` and `EnoughFactory-0.1.0-linux-x64.AppImage`. Select the archive matching your device. Mac packaging is unsigned unless release signing credentials have been configured. Unsigned builds are labeled as such in the release manifest; macOS can ask for confirmation when opening them. Signing/notarization status must not be inferred from a successful packaging command.

## Install the Mac user service

The application contains both the installer and its Node runtime. After placing it in Applications, run:

```sh
"/Applications/EnoughFactory.app/Contents/Resources/runtime/node" \
  "/Applications/EnoughFactory.app/Contents/Resources/install/install-device-service.mjs" \
  --resources "/Applications/EnoughFactory.app/Contents/Resources"
```

This copies service resources into `~/Library/Application Support/EnoughFactory/service`, writes `~/Library/LaunchAgents/com.enoughtools.factory.device.plist` and enables login startup with launchd. It uses `~/.enoughfactory` for state and port 4317 for local connections. Re-run the command after installing an updated app to update the service copy.

An update retains the installed state directory, port and startup location unless you explicitly change those options. The installer stops a previously managed or desktop-started device service through its authenticated local API before replacing resources. Envmux sessions remain recoverable; restarting the device service is not an explicit session stop.

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

Use the uninstall script from the installed stable service copy. It stops user startup and removes the copied application resources while preserving device state, conversations and project references:

```sh
# Mac
FACTORY_SERVICE="$HOME/Library/Application Support/EnoughFactory/service"
# Linux instead: FACTORY_SERVICE="$HOME/.local/lib/enoughfactory/service"
"$FACTORY_SERVICE/runtime/node" \
  "$FACTORY_SERVICE/install/uninstall-device-service.mjs"
```

Add `--purge` only when you also want to remove the device's state directory, including chats, goal records, cached candidates and device-local workspace data. Repositories outside that directory remain independent. Stop active factory work and explicitly stop environments before uninstalling; removing the device service is not a request to discard or harvest every Docker session.

Advanced installation supports `--home`, `--port`, `--service-dir`, `--unit-dir` and `--no-start`. A custom state path must also be supplied to the desktop through `ENOUGHFACTORY_HOME` so it can discover the same connection. Use the matching `--service-dir` when removing a custom installation. `--no-stop` is available for removing a staged installation that was never started.

## Build a release

Build from the repository root with the pinned package manager and dependencies installed. Native envmux executables must already be published into `artifacts/envmux/<target>/envmux`, where targets are `osx-arm64`, `osx-x64`, `linux-x64` and `linux-arm64`. Intel Mac packaging is available only after its `osx-x64` engine has also been built.

```sh
node scripts/package-desktop.mjs --platform darwin --arch arm64
node scripts/package-desktop.mjs --platform linux --arch x64
```

The script builds the web/device/desktop packages, prepares resources, then invokes electron-builder with publication disabled. Mac packaging runs on Mac. Native WebRTC assets are fetched for the selected target rather than copied from the build host: `node-datachannel` 0.33.4, `detect-libc` 2.1.2 and the matching `@node-datachannel` binary package. Each archive is checked against its exact pinned SHA-512 integrity and the official npm registry metadata. Linux releases target glibc distributions, not musl. When the packaging host matches the target, preparation loads the isolated bundled module and creates/closes a peer connection. Other targets still need their own packaged runtime check. `--skip-build` uses already-built packages, `--prepare-only` stages resources without calling electron-builder, and `--dir` produces an unpacked application for focused verification.

Node archives come directly from `https://nodejs.org/dist/v22.22.0/`. Packaging checks the archive SHA-256 against both the official HTTPS `SHASUMS256.txt` and the checksum pinned in the packaging script. A changed checksum fails packaging. Cached archives are checked again, not blindly reused. The bundle includes Node's license and a `runtime/provenance.json` with the source URL, target and verified digest.

Resources contain `runtime/node`, `device/service.cjs` and its native assets, `envmux/envmux`, the built web app, complete `workspaces` container runtime helpers, the `agents` Antigravity bridge, installers and upstream notices. Agent Python code runs in its container; a host Python installation is not required. The Electron renderer does not run the device service. A missing native engine, built web client, workspace runtime, agent bridge, bundled service or distribution notice fails packaging rather than producing a partial desktop release.

`bundle-provenance.json` identifies the product version, platform, architecture, Node version and native module integrity pins, and records SHA-256 hashes for every prepared resource. The desktop uses this identity when staging resources into a stable device-service directory. This is required for AppImage builds, whose temporary mount disappears after the desktop exits. The installer retains the same bundle provenance in its stable copy.

## Release verification and notices

For each required target, open its packaged application, confirm the bundled device service answers the authenticated `/api/health` request, open a real Docker-backed session, and close/reopen the desktop while the session continues. Verify user startup installation and removal on that OS. Use one complete factory journey for the assembled release rather than repeating extensive checks for every packaging change.

Publish the built archives, their SHA-256 hashes, architecture and actual signing status through the release manifest used by `factory.enoughtools.com`. Never label an archive available before its download URL has been verified. Include `LICENSE`, `THIRD_PARTY_NOTICES.md`, the Node runtime license and the original envmux and EnoughUI notices with the distribution. The Enough application icon is the supplied brand mark; its separate license is included in `apps/desktop/assets/LICENSE`.
