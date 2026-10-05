# Browser

**A browser whose `localhost` is the instance.**

Press `b`. Chrome, Firefox or Edge opens on a profile of its own at a route —
`http://localhost:3000/`, say — and that is port 3000 *inside the instance*.
It even reaches a dev server bound to the instance's own `127.0.0.1`, which a
[route](routing.md) cannot. Everything else the page loads — Google Maps, a
font, a sign-in page — leaves from this machine, the way it would in any other
browser here.

```console
$ envmux feat-login
...
09:41:06  browser → socks5 on 127.0.0.1:1080; localhost is the instance, the rest leaves from here
09:41:06  browser proxy → socks5h://myproj-feat-login:Zq3…@127.0.0.1:1080
```

No route, DNS rule, zone or certificate is involved. `localhost` is a secure
context by origin, so service workers, `crypto.subtle` and the clipboard
should work over plain http, as they do on a laptop. That is expected browser
behaviour, not something tested here.

## How it works

The session claims a SOCKS5 port on `127.0.0.1` when it starts, next to the
[portal](portal.md). It starts at 1080 and walks upward if that port is taken,
so two sessions get two ports. It is part of the `envmux` process, not a
daemon, and it goes when the session does.

A connection to the loopback (`localhost`, anything under `.localhost`,
`127/8`, `[::1]`) is made from *inside* the instance. It travels over an exec — Incus', or
Docker's for a [Docker](docker.md) session — the channel envmux already uses
for shells and tasks. The exec runs a
few lines of bash that open the port with `/dev/tcp` and copy both ways, so
nothing is installed in the image. A name is tried on IPv4 and then IPv6,
because Node servers bind whichever `localhost` resolved to first.

Everything else goes where `browser.egress` says:

| `browser.egress` | Other traffic leaves from | Use it when |
|---|---|---|
| `"local"` (default) | this machine, with its DNS | almost always: maps, fonts, SSO and CDNs behave as they do in your own browser |
| `"instance"` | the instance, with its DNS | the app names things only the instance can resolve, or must be seen coming from its address |

Each new connection into the instance costs one exec, about 50–65 ms against a
LAN host. A browser keeps its connections open, so that cost is per socket,
not per request. WebSockets go through the same way; Vite's HMR connects.

## Before the server is up

Press `b` while `npm ci` is still running and the port has nothing on it yet.
If a route or a task's `ready` declares that port, the proxy answers the
request itself with a 503 page: **"proof is starting"**, and the most specific
thing the session knows underneath:

- the session is still starting (and at what step),
- a task is waiting on another (`Task 'proof' is waiting on proof-install.`),
- a task has stopped or failed, so the page will not finish on its own,
- a task was stopped, and how to start it again.

The page polls its own URL once a second and reloads the moment the answer
is the app's rather than envmux's. It tells the two apart by the
`X-Envmux-Loading` header. Stop a dev server while its tab is open and the
same thing happens in reverse: Vite's client notices, reloads into the
starting page, and returns to the app when the server does. Measured: back
about 2 s after the task restarted.

A port nobody declared is still refused, because a page that waits for a port
nothing will ever open is worse than the browser's own error. An https route
is refused too: there is no certificate here to answer TLS with.

## Who gets in

The port says which session a connection is for. It does not say the
connection is allowed: anything on this machine can dial a loopback port. So
a connection is let in only if it:

- **sends the session's username and password** (RFC 1929). The username is
  the instance name; the password is minted per run and is in the log line
  above. This is how curl, scripts and a browser you configured by hand get in:

  ```console
  $ curl -x socks5h://myproj-feat-login:Zq3…@127.0.0.1:1080 http://localhost:3000/
  ```

- **or is a browser this session opened**, or one of that browser's child
  processes. Chrome cannot send a SOCKS5 password at all
  ([crbug 40323993](https://issues.chromium.org/issues/40323993)), and since
  Chrome 137 it cannot load an extension from the command line to add one. So
  the proxy asks Windows which process holds the other end of the connection
  and walks up its parents. Windows only, for now.

Anything else is refused, and the log names the process:

```
09:42:10  browser: refused curl (pid 35636) — no password, and not a browser this session opened.
```

## The browser it opens

- **Its own profile**, under `~/.envmux/browsers/<instance>/<browser>`. Every
  session's app lives at `localhost:3000`, so a shared profile would share one
  app's login with another. A profile is kept while its instance is kept, and
  removed with it.
- **Named and coloured.** The window is called `envmux <instance>` — in its
  title bar, the taskbar and Alt-Tab, in place of the page's title — through
  Chrome's own `--window-name`, which is what its "Name window" menu sets. A
  new Chrome or Edge profile also gets a colour theme: one of ten, picked from
  the session's name so a session keeps its colour, or `browser.color`,
  written into the profile's own state before its first launch, with no
  extension; a colour changed in the browser afterwards sticks. The profile
  name is written too, but a single unsigned-in profile's button shows
  "Sign in to Chrome?" whatever it is called, so the window name is the label
  that is seen. Tab groups were considered: Chrome keeps them only in its
  binary session files and an extension, so there are none.
- **Enter opens what is selected.** On a task, its route or `ready` port; on
  a route, that route.
- **Loopback through the proxy.** Chromium sends `localhost`, `127/8` and
  `[::1]` straight to this machine whatever the proxy says, unless it is started
  with `--proxy-bypass-list=<-loopback>`. Firefox needs
  `network.proxy.allow_hijacking_localhost`. envmux sets both.
- **Which one**: `browser.use` (`"chrome"`, `"firefox"`, `"edge"`, or a path),
  otherwise the first of those found. `/browser firefox` picks one for a single
  launch.
- **Where**: `browser.open`, a route's name or a URL, otherwise the first web
  route by name. `/browser proof` or `/browser localhost:5173/admin` opens
  somewhere else once.

The [portal](portal.md) has the same button: *open a browser in the instance*.

## What it does not do

- The portal itself is not reachable from that browser. Its `127.0.0.1:8080`
  is the instance's `127.0.0.1:8080` there. Open the portal in your usual
  browser.
- An `https` route presents whatever certificate its own server has — envmux
  issues none — and the browser warns unless that one is for `localhost` and
  trusted. Plain http on `localhost` needs no certificate.
- UDP does not go through, so there is no HTTP/3. Browsers fall back to TCP
  on their own.
- Firefox support is written but has not been run on a machine with Firefox.

## Configuration

```jsonc
{
  "browser": {
    "egress": "local",   // or "instance"
    "port": 1080,        // or [1080, 1089]
    "use": "chrome",     // or "firefox", "edge", a path; default: first found
    "open": "web"        // a route name or a URL; default: the first web route by name
  }
}
```

`"browser": { "enabled": false }` claims no port. See
[Configuration](configuration.md#fields) for every field.

## macOS release candidate

Use the `osx-arm64` archive on an Apple Silicon Mac with Git and Docker Desktop's
Linux engine running. Run `./envmux install --check`, then `./envmux install`,
and open a new terminal. No .NET SDK is required for the native release.

Install Chrome, Firefox or Edge in `/Applications` or `~/Applications` for the
session browser. envmux launches its app-bundle executable with a separate
profile and authenticates proxy connections using macOS `lsof` and `ps`.
Safari is not supported. VS Code Dev Containers uses a private Unix socket;
explicit SSH attach remains available. The macOS binary is unsigned and
unnotarized: verify the release checksum before approving it through macOS.

For a first check, run `envmux init --skills both`, `envmux config validate`,
`envmux --dry-run`, then `envmux mac-smoke` in a Git project with a commit.
Check that the portal opens, the session browser reaches your development task,
and VS Code attaches. Report the command, envmux version and error text, without
credentials, tokens or private repository contents.
