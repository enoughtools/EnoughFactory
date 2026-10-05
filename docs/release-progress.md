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
