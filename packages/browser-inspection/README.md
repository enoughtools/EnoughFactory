# Managed browser inspection

`BrowserInspectionManager` prepares a digest-pinned shared Chromium/Playwright MCP image lazily, then owns one isolated browser sidecar per author lease. The sidecar shares only the author's container network namespace, so its loopback app is reachable without publishing host ports. Profiles and bounded scratch output retire with that sidecar; original screenshots remain in ArtifactStore.

Use `prepare`, `listTools`, `call`, `reconcile` and `retire` with explicit authority/source identities. `call().result` contains the original image bytes for provider delivery; `call().event` is the compact durable record containing artifact references. The device service owns authentication, fresh observations, source validation and provider-specific image receipt. This package does not by itself establish that a model inspected an image.

Preparation, action and retirement journals preserve uncertain outcomes across service restarts. Reconciliation never replays an interrupted action. Cancellation stops only the owned sidecar and independent callers of shared image preparation can cancel without interrupting other waiters. Docker operations require the explicit EnoughFactory private endpoint and verified installation-owner labels.

## Container pilot

`pnpm --filter @enoughfactory/browser-inspection verify:container` is an opt-in integration journey. It requires the running EnoughFactory-owned private engine, the bundled Docker CLI, the private configuration directory, and an **already inspected immutable ID** for the local `node:22-bookworm` fixture image. It never falls back to Docker contexts or the user's daemon.

Set these explicit inputs before running:

```sh
export ENOUGHFACTORY_BROWSER_PILOT=1
export ENOUGHFACTORY_DOCKER_HOST=unix:///absolute/path/to/the/private/docker.sock
export ENOUGHFACTORY_DOCKER_CLI=/absolute/path/to/bundled/docker
export ENOUGHFACTORY_DOCKER_CONFIG=/absolute/path/to/private/docker/config
export ENOUGHFACTORY_BROWSER_PILOT_AUTHOR_IMAGE=sha256:<inspected-local-Node-22-bookworm-image-ID>
pnpm --filter @enoughfactory/browser-inspection verify:container
```

The journey validates the daemon's managed/installation-owner labels before container mutations. It creates two uniquely labeled disposable author containers, each serving a distinct app on `127.0.0.1:3000`, and asks the real `BrowserInspectionManager` to prepare the pinned shared browser image and per-attempt sidecars. Cold preparation may download the digest-pinned Chromium image once.

It verifies a composer close-button defect through accessible browser interaction, retains an actual PNG image response, repairs the HTML inside the owned fixture, and verifies the repaired interaction using a fresh source identity. It also checks same-port app and cookie isolation, shared image reuse, pending-request cancellation without stopping the author, evidence integrity after browser retirement, and reconciliation of a ready lease by a new manager instance. Cleanup targets only the exact owned fixture IDs and verified browser leases; shared tooling remains cached.

Receipts, compact tool records, and screenshots are retained beneath the repository's `.cache/enoughmail-run/browser-inspection-pilot/`. Receipts distinguish actual browser/MCP/image transfer from provider-model image receipt: this pilot does **not** claim a Codex/Claude/Antigravity model consumed the image or that any native application passed acceptance.
