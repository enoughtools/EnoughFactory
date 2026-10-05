# Shipping plan: try-before-install

Four threads, sequenced. Written 2026-08-09.

The through-line: **asking someone to install a background service to evaluate
a tool is asking a lot.** GitHub's runner setup is the model — download an
archive, run a binary, see something useful, and only then decide to install
anything permanently.

---

## 1. Docs site with Vocs

**Done in this pass.** `vocs.config.ts` at the repository root, pages under
`docs/pages/`, sidebar split into *Using it*, *Working on it*, and *Design*.

```console
$ npm run docs:dev        # http://localhost:5173
$ npm run docs:build
```

Single source: the pages are the same Markdown GitHub renders, so there is no
second copy to drift. Moving them together preserved every relative link
between them.

**Remaining:** publish. A GitHub Pages workflow on push to `main` building
`docs/dist`. Not added yet — decide the domain first (`docs.strigops.xyz`?),
because Vocs needs `basePath` set correctly for a project-path deployment.

---

## 2. `envmux` with no arguments opens a TUI

Today `envmux` prints help, and every path assumes a daemon is already
installed and running. The primary path should instead be:

```console
$ ./envmux
```

…and you get an interactive terminal UI that starts a daemon in the background
if there is not one, shows your namespaces and workspaces, and lets you create,
attach, and reap without learning a command surface first.

### Behaviour

| Invocation | Result |
|---|---|
| `envmux` on a TTY | the TUI |
| `envmux` with stdout redirected | help, exactly as now — scripts must not get a UI |
| `envmux <subcommand>` | unchanged |
| `envmux tui` | explicit, for when stdout is redirected but a UI is wanted |

Detecting a TTY rather than guessing is the whole trick, and it is the one part
that must not be clever.

### Look and library

[Ratatui](https://ratatui.rs/installation/), and the look is **cyberpunk**:
neon accents on dark, heavy box drawing, unapologetically terminal-native
rather than a GUI in disguise.

This is not decoration. The TUI is what someone sees *before* they decide to
install anything, so it is the pitch — the same role the screenshot plays for
a desktop app.

### Portable mode

Portable is about **where state lives**, not a separate build:

- If a directory named `state/` sits beside the executable, use it.
- Else `$ENVMUX_STATE_DIR`.
- Else the platform data directory, as now.

So an extracted archive that contains `envmux`, `ui/`, and an empty `state/`
is self-contained: mirrors, shadow history, the CA, and the database all stay
inside the folder, and deleting it leaves nothing behind. The release archives
already exist; they gain the `state/` marker and a short `README-portable.txt`.

The TUI should say which mode it is in, because "where did my workspaces go"
is the obvious failure otherwise.

### Install as a second step

A menu entry — and `envmux install` — that copies the binary and `ui/` to the
per-user location, adds it to `PATH`, and offers to write a service unit. This
is the `scripts/install.ps1` work generalised and moved into the binary, which
also makes it available on macOS and Linux where there is no install script
today.

### Implementation

`ratatui` + `crossterm` (already a dependency). Views mirroring the portal,
because the model is proven: workspace list, task graph, lease actions,
snapshot list. Terminals are `attach`, which already works.

The TUI is a client of the same IPC API as the CLI. No new surface.

### Cost and risk

Perhaps a week. The risk is scope: a TUI invites feature creep, and the honest
target is "enough to evaluate envmux without reading the docs", not a second
complete interface. Anything not on that path belongs in the CLI or the portal.

---

## 3. WebSockets in the desktop app

**Question asked:** can the webview auto-accept a self-signed certificate for
mTLS, via Tauri config?

**Answer: no, not portably — and it should not need to.**

Each platform can ignore certificate errors, but through a different,
non-portable seam: WebView2 has `ServerCertificateErrorDetected`, WKWebView
needs a navigation-delegate override, WebKitGTK has its own. Tauri and wry do
not expose a common API for it, so it would be three pieces of unsafe-ish
platform glue to maintain — and it would mean deliberately teaching a browser
engine to ignore certificate errors, which is a bad habit to build into a
product whose whole security story is mTLS.

Worse, it does not actually solve the problem. Even with the server certificate
accepted, the webview would still have to present a *client* certificate for
mTLS, and browser client-certificate handling is exactly what the concept
design rules out.

### Recommended: stream over Tauri IPC, no socket at all

Terminals do not need a WebSocket in the desktop app. Tauri v2 has `Channel`
for streaming Rust → JS, and commands for JS → Rust. That is a full duplex
terminal:

```
terminal_open(workspaceId, task, readOnly, onData: Channel<Bytes>) -> sessionId
terminal_send(sessionId, bytes)
terminal_resize(sessionId, cols, rows)
terminal_close(sessionId)
```

The Rust side holds the WebSocket to the daemon over the existing mTLS
connection — which is HTTP/2, so the terminal stream multiplexes alongside the
REST polling on the same connection. Nothing new is exposed, no token is
minted, no certificate is accepted that should not be, and the frontend change
is one transport shim beside the REST one already there.

The portal already abstracts its transport for exactly this reason.

### Fallback, if IPC throughput disappoints

Your suggestion, and it is the right fallback: the **app** hosts a loopback
listener, mints a token over the existing mTLS RPC, and the webview connects to
`ws://127.0.0.1:<port>/…?token=…`. Plain `ws://` is defensible there because
the hop never leaves the machine and the app→daemon hop is still mTLS. It costs
a listener, a token lifecycle, and an origin check — which is why it is the
fallback and not the plan.

I would measure before reaching for it. A PTY at human typing speed and a few
hundred KB/s of scrollback is not a demanding stream.

---

## 4. Single-label routing hosts — DONE

Today's structured host is three labels deep:

```
p8000.wobbly-otter.acme.envmux.localhost
```

which no wildcard certificate can cover, because RFC 6125 wildcards match
exactly one label. Host-form routing therefore fails certificate validation
everywhere, and only the path form works.

**Shipped**, and with plain ASCII rather than punycode — an underscore
delimiter gets the same single label without an IDNA round-trip on every
request:

```
acme_wobbly-otter_8000.strigops.xyz
```

Verified against a real certificate: `*.strigops.xyz` covers hosts with
underscores in the label, rustls parses them as SNI, and a nested host is
correctly refused. Both facts are now regression tests.

One label, so `*.strigops.xyz` on the local CA covers every workspace and port
that will ever exist — no per-workspace reissue, no cert churn on create and
reap.

`ø` is a good delimiter: valid under IDNA2008, and it cannot collide with
generated workspace names (petnames: lowercase ASCII and hyphens) or with
validated namespace names.

### What it needs

- **Config.** `[routes] domain` and `delimiter`, defaulting to `strigops.xyz`
  and `ø`. Both configurable, as asked.
- **Encoding.** The `idna` crate (already in the tree via `url`) to encode when
  building URLs and decode when parsing the `Host` header. The proxy's
  `parse_host` becomes: strip the domain suffix, IDNA-decode the remaining
  label, split on the delimiter.
- **Certificate.** The daemon's server certificate gains `*.<domain>` and
  `<domain>` as SANs.
- **Tests.** Round-trip encode/decode, a delimiter that appears in no valid
  name, and rejection of a host that decodes to the wrong field count.

### What to decide first

**Wildcard DNS.** `*.strigops.xyz` must resolve to `127.0.0.1`, the way
`localtest.me` and `sslip.io` do. That is a one-line DNS record on a domain you
control, and it buys away every `/etc/hosts` instruction. Three consequences
worth accepting deliberately:

1. **It is a public DNS dependency.** Resolution fails offline, and `.localhost`
   did not. Mitigation: keep the path form as the guaranteed-offline route, and
   consider `envmux status` warning when the domain does not resolve.
2. **Workspace and namespace names leak into DNS queries** to whatever resolver
   the machine uses. They are not secret, but they are project names, and
   somebody will care. Worth a line in the docs.
3. **The domain becomes infrastructure.** If the record lapses, routing breaks
   for everyone. A `.localhost` fallback for the paranoid costs little.

### Sequencing

This is self-contained and the smallest of the four. It also retires a known
limitation rather than adding surface, so it is a good one to do first.

---

## Order

1. ~~**Single-label hosts**~~ — done.
2. ~~**Terminals over Tauri IPC**~~ — done.
3. ~~**TUI and portable mode**~~ — done. See [the TUI](/tui).
4. **Publish the docs site** — once the domain decision above is made, since it
   shares it.
