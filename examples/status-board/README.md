# Status board example

A working Node HTTP app with no npm dependencies. It serves a small status page,
checks a cache with a real protocol `PING`, and reports unavailable dependencies
through HTTP 503 and a recoverable UI state. Node 22.14 or newer is sufficient
for local use; `npm install` is unnecessary.

```sh
cd examples/status-board
npm test
npm start
```

Open `http://localhost:3000`. Without `CACHE_HOST`, the page shows standalone
mode. With `CACHE_HOST` and optional `CACHE_PORT`, it checks the configured cache.
`/health` and `/api/status` return the same JSON status. The tests exercise actual
HTTP/TCP connections, including a fragmented protocol reply and a failed cache.

## Open it in EnoughFactory

Copy this directory to a new location outside the EnoughFactory checkout and
make it an independent Git repository. From the EnoughFactory repository root:

```sh
cp -R examples/status-board "$HOME/code/enough-status-board"
cd "$HOME/code/enough-status-board"
git init -b main
git add .
git commit -m "Start the status board example"
```

Use a destination that does not already exist and your normal Git author
configuration. Add that new repository through **Add project**, inspect its
environment configuration, then choose **Start environment**.

The committed `.envmux.json` uses the engine's current fields:

- A Node feature requests version 22.22.0 in the development container.
- The `cache` service uses [Valkey 8.1.10](https://valkey.io/download/), an OSS
  cache compatible with the engine's `redis` service type. Envmux injects
  `CACHE_HOST` and `CACHE_PORT`; no host cache installation is needed.
- The once-only `checks` task runs `npm test`. The `web` task waits for successful
  checks and the cache, starts the app, and declares port 3000 for readiness.
- The `web` route opens the running app in **Preview**. Services and task output
  remain visible in the workbench.

First preparation downloads the Node feature and service image. Work runs in
EnoughFactory's private runtime. Stop the environment to harvest its source
changes; this disposable cache service is scoped to the session.

## Give the factory a goal

Connect your selected provider, create a goal for this repository, and select
**Autonomous** and **Approve all** independently. A useful goal to copy is:

```text
Turn this status board into a small team check-in app. Let a person enter a
name and a short status, submit it, and see the latest check-ins. Store the
check-ins in the configured Valkey service so they survive page reloads.
Keep the application dependency-free and preserve the existing health route.

Completion criteria:
- Adding a check-in updates the page; reloading keeps the submitted entries.
- Empty names are rejected with a useful message.
- The form has labels and works with the keyboard.
- Cache failure shows a useful unavailable state and recovers after retry.
- npm test passes and includes meaningful checks for the new behavior.
- The accepted repository contains the working app and concise usage notes.
```

Include `npm test` in the goal's checks/context. Follow the plan, attempts and
accepted evidence in the goal workspace.

The example source is MIT licensed under the included [LICENSE](LICENSE), the
same license as EnoughFactory. Downloaded toolchain/service distributions retain
their upstream licenses; [Valkey's license](https://github.com/valkey-io/valkey/blob/8.1/COPYING)
is BSD-3-Clause.
