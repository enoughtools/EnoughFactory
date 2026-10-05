# EnoughFactory release progress

This ledger records implementation and release evidence without treating a source build, a passing focused suite or a published website as proof of every product requirement. The public source repository is [enoughtools/EnoughFactory](https://github.com/enoughtools/EnoughFactory); the product site's target is `factory.enoughtools.com`.

## Implemented product layers

| Layer | Current source | Evidence boundary |
| --- | --- | --- |
| Envmux workbench | Shared EnoughUI interface, device-owned engine adapter, services/logs/terminals/previews/changes, Electron shell | Real session behavior is verified separately from native packaging |
| Agent workspace and policies | Container runtime adapters, chats, typed decisions, questions, interruption and supported resume | Codex has a documented real full-access turn; other provider inference needs its own credentials and journey |
| Connected devices | Native/browser peers, identity pairing, direct RTC, encrypted relay, streams and artifact transfer | A two-service test covers direct/relay/reconnect; it does not cover every NAT or deployed TURN configuration |
| Coordinated work | Durable coordinator, isolated candidates, checks, integration fencing and recovery | Focused authority/recovery tests cover the risky state transitions; assembled real-agent behavior is a separate journey |
| Autonomous goals | Planning, dispatch, diagnosis, repair, evaluation and persisted next action | A goal completes only against retained criteria at the evaluated accepted repository head |
| Distribution | Native resources, Mac/Linux packaging, user service install/remove, marketing site and launch materials | Artifact availability, runtime checks, signing and deployment are recorded per release |

These are implementation references, not a claim that the full release audit has passed. Relevant package READMEs document exact interfaces and focused verification commands.

## Existing recorded runtime evidence

The [agent adapter README](../packages/agents/README.md) records a 2026-10-05 real pinned Codex app-server turn authenticated in a disposable envmux container. It wrote under `/root` and `/work` as uid 0 and finished without a renderer approval. Container connection and descendant interruption checks also passed. Antigravity bridge configuration was checked against the published SDK wheel; SDK inference requires separately configured Gemini/Vertex credentials.

The [peer README](../packages/peers/README.md) defines the focused two-service direct RTC, encrypted relay, terminal/artifact and reconnect exercise. The [workspace README](../packages/workspaces/README.md) defines source retention, candidate validation, integration, retired authority and corrupt transfer exercises. Their commands are repeatable evidence procedures; a command's existence alone is not a recorded pass.

## Release requirements still tracked

- Run required builds/type checks and a complete real factory goal, including continuation and accepted evidence.
- Verify the packaged native service and desktop journey on each published OS/architecture; validate login service install/removal on Mac and Linux.
- Attach actual signing/notarization status, SHA-256 digests and verified download URLs to each artifact. Do not expose a download before its artifact is reachable.
- Preserve upstream, dependency, native runtime and font licenses in source and desktop/image distributions.
- Publish the public OSS repository and release assets, deploy the product/marketing site to `factory.enoughtools.com`, and verify its HTTPS routes and links.
- Check onboarding, offline/intervention states, keyboard use, recovery and the assembled marketing/download path at the release version.

The release owner should append authoritative command results, artifact URLs, signing status and deployment evidence below as those actions finish. Completing one item does not retire the rest of the full-product objective.

## 2026-10-05 assembly evidence

- The public GitHub repository was created and private vulnerability reporting enabled. Publishing the source tree and native release assets remains a separate step.
- Native envmux executables were produced for Mac ARM64, Linux x64 and Linux ARM64. A self-contained executable build proves that target's engine artifact exists; it does not prove its desktop installation journey.
- The bundled device service was started using its built CommonJS output and answered its local API. Its entrypoint now derives source-relative paths from the actual bundle location. Native package readiness is still checked against each final resource tree.
- Real direct WebRTC, TURN/relay and browser RTC checks were reported by the connectivity owners. The assembled remote-preview journey remains under verification; isolated transport evidence is not a proxy for HTTP/WebSocket preview correctness.
- The distribution notice was prepared from contributing production bundle modules and native runtime resources. It preserves full texts for the embedded JavaScript, .NET, native WebRTC, fonts and upstream components, including MPL source availability. Final artifacts must retain it alongside Electron's Chromium and Node's complete original notices.

These entries reflect the integration owners' actual completed observations at assembly time. The complete factory journey, per-platform packaged desktop checks and public deployment/download checks are tracked independently.

## Owned-runtime scope update

The product now requires EnoughFactory's own container engine, private socket, configuration and storage. Existing Docker installations are not a prerequisite or fallback. Mac uses bundled Lima 2.2.1 with Apple virtualization and Docker 29.8.2; Linux uses bundled Docker 29.8.2 plus rootless extras. [Pinned inputs](../runtime/container/pins.json) include architecture-specific archive digests and Ubuntu 24.04 cloud image digests. The Mac archive includes the pinned OS image; first start creates a private writable VM disk from it.

Earlier Mac archives and factory journeys were produced before this owned-runtime requirement. They remain useful evidence for their tested code paths, but are not release artifacts or proof of the new execution boundary. The assembled factory journey is recorded in [product-journey.md](verification/product-journey.md); it must be exercised against the owned runtime for final release evidence.

Required additional evidence is tracked explicitly: bundled asset/provenance/license inspection, complete source companions for redistributed operating-system packages and relink materials for linked LGPL libraries; private engine start, recovery and stop; ordinary source/agent/check work through its endpoint; no mutation or fallback to existing Docker state; Mac ArtifactFS behavior; Linux rootless host prerequisites and visible compatible Git fallback; and rebuilt Mac/Linux desktop bundles. Website/download publication follows those actual artifacts and verified URLs.

The [private Linux runtime evidence](verification/private-linux-runtime.json) records a real ARM64 Linux run in the application-owned VM: root writes inside containers, private socket and data root, envmux source retention, engine restart and volume retention, and an unchanged user's Docker configuration. This establishes the Linux runtime behavior on that host; it does not substitute for a packaged Linux desktop check or final source-build runtime checks.

## Source and license assembly

The engine's [source and relink kit](../runtime/container/relink-kit/README.md) pins Moby, runc, libseccomp, Tini and their build toolchains. The source-built daemon/proxy use cgo-disabled Go; runc and Tini use musl, with libseccomp retained. [Native verification](../runtime/container/relink-kit/verification/native-verification.json) records static replacement binaries and a relocated x64 object relink. The [ARM64 engine exercise](../runtime/container/relink-kit/verification/docker-engine-verification.json) records init and seccomp using a dedicated inner Docker daemon in the application-owned runtime. This proves those components' behavior; final managed-engine and factory journeys must bind the installed replacement hashes.

The [guest-image evidence](../runtime/container/os-source-kit/image-evidence/summary.json) records 663 installed apt packages on ARM64 and 664 on x64, copyright paths for every installed package, no preinstalled snap payload and unchanged image hashes after read-only extraction. Original copyright/common-license archives and exact package-to-source mappings are retained in the [Ubuntu source kit](../runtime/container/os-source-kit/README.md). Signed archive indexes resolve exact package versions and their additional embedded source payloads.

The engine's [source-artifact receipt](../runtime/container/relink-kit/verification/source-artifact-verification.json) independently verifies 18 source archives, 31 retained runc objects and 76 native retained files per architecture, the root MIT license and eight implementation scripts/pins. Its generic companion is 63,940,781 bytes with SHA-256 `e8c4dc37f18d0137e4a0dbfc5b3a4fe62d95f85c4543997919959609afee4684`. Release copies qualify host platform and architecture; each final prepared runtime retains its own matching receipt.

The Ubuntu source companion is locally complete and verified for 442 source package versions and 1,357 source files. Seven prepared assets are under `dist/ubuntu-source-companion`. Both source parts are required:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `EnoughFactory-Ubuntu-24.04-20260926-sources-part01.tar.gz` | 766,180,065 | `de08b49f7ab2882b803f2b3bff3b44feaf193f4e7a75eb5ad8a0ff7f191d3704` |
| `EnoughFactory-Ubuntu-24.04-20260926-sources-part02.tar.gz` | 611,450,171 | `6b27dc2436620fdc7e057facfc454d4b504b983e603c7fe5d079116ffcebaa86` |
| `Ubuntu-archive-evidence.tar.gz` | 99,066,216 | `fc6d93e8ebd64963b2993f96e7ba6ef8f51a0c4e7d975128d2c36fbb25040643` |

The other required assets are `Ubuntu-sources.lock.json`, `Ubuntu-source-companion.json`, `Ubuntu-source-companion-SHA256SUMS` and `Ubuntu-source-companion-README.md`. Upload all seven to the same public release as the installers and retain them while those installers remain available. Local assembly is complete; public download access remains a release-owner action.

The combined notice is frozen for packaging at 6,248,559 bytes, SHA-256 `574a0671f4628e09ea6f47d50c477601af72cfdb42a7d605a0fb4470b081b4ac`, with 92 component entries and 57 preserved full-text groups. Local document links, notice references and fenced text blocks passed their focused checks.

## Current owned-runtime product journey

The [real factory receipt](verification/factory-managed-runtime-evidence.json) records a fresh private Mac VM using the rebuilt engine, poisoned inherited Docker configuration, real Codex planning, execution, diagnosis and evaluation, retained candidate recovery across a service update, and exactly one integration. All ten retained completion criteria were satisfied at source `371b6e36bc6e91a051da20dfcceda40706fc1c3e`; the CLI passed 28 focused checks. The fixture's engine and service stopped cleanly after completion.

The initial smoke override selected Debian slim without Git. Its fail-fast reports exposed a misleading coordinator diagnostic; the corrected coordinator retains the failed command output, and the fixture resumed using the product's normal Git-capable Node check image. This receipt preserves the actual earlier attempts rather than presenting the journey as an uninterrupted pass. Confirmed failed attempts are protected separately by the recovery regression.

The current source Electron shell was opened and inspected on the unlocked Mac. Workbench and Settings rendered correctly; runtime details showed Lima 2.2.1, Docker 29.8.2 and the application-owned socket. This source UI observation is separate from the final packaged GUI, startup/removal and archive receipts required for publication.

## EnoughFactory 0.1.1 public desktop release

[EnoughFactory 0.1.1](https://github.com/enoughtools/EnoughFactory/releases/tag/v0.1.1) is public. All six downloads use source `5252bd83a9082d7711e7e3dcbf426daef0abc165`: Mac Apple Silicon DMG/ZIP, Linux x64 AppImage/tar, and Linux ARM64 AppImage/tar. These builds are unsigned; Mac builds are not notarized. Every exact archive has a native extraction/resource receipt bound to its actual private-runtime journey. All targets also have sandboxed desktop and login-service install/remove receipts. The physical Mac additionally passed the installed service's runtime/session API, retained-session restart, root writes, exact source recovery and clean shutdown.

The [native Linux build run](https://github.com/enoughtools/EnoughFactory/actions/runs/37379810420) passed both Linux targets and complete Ubuntu source reproduction. Its hosted Mac archive check encountered a `/var` folder alias; equivalent physical Mac DMG/ZIP checks passed, and canonical-path verification is corrected on main. The x64 AppImage builder used `x86_64` in its filename, which the original release glob omitted. The unchanged bytes were renamed to the catalog's `x64` convention and [verified on native Ubuntu](https://github.com/enoughtools/EnoughFactory/actions/runs/37382264177), without rebuilding the payload or repeating the private-engine journey.

All three engine source/relink archives and records, all seven locally audited Ubuntu companion files, native proof records and screenshots are public assets on the same release. The selected Ubuntu set retains the locally audited index and archive hashes above; the CI reproduction independently matched the immutable source lock. GitHub's server digests were compared with all 41 uploaded installer/source/proof files before publication. `SHA256SUMS` and `provenance.json` add complete release hashes and evidence links. The launch site deployment is recorded below after its public checks complete.
