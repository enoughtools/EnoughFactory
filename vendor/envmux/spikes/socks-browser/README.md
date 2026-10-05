# socks-browser spike: a browser whose loopback is the instance's

The idea: envmux runs a SOCKS5 listener on the workstation's loopback, and
launches a browser on its own profile pointed at it. That browser's
`http://127.0.0.1:3000` (or `localhost:3000`, or `[::1]:3000`) is then the
instance's port 3000, reached over the channel envmux already has into the box.
There is no route, NRPT rule, zone, certificate or published port, and a dev
server bound to the guest's own `127.0.0.1` is reachable too.

This spike proves the **browser half** on this machine alone. `socks.cs` is a
SOCKS5 listener plus a small HTTP server on another loopback port that stands in
for the instance. The **exec half**, which carries each CONNECT to the guest's
loopback over an Incus exec, was then built into envmux and run against the
real host (see the last section).

Run on 2026-09-19 with Chrome 153.0.8010.50, Edge 153.0.4234.48 and .NET 10.0.400.
Firefox is not installed here.

```sh
dotnet run socks.cs -- browsers                                   # Chrome + Edge headless, 12 cases
dotnet run socks.cs -- launch "<path to msedge.exe>" http://localhost:3000/ 10 headless
dotnet run socks.cs -- serve                                      # then curl --socks5-hostname …
```

## Findings

**1. Loopback goes through the proxy only when you ask for it.** Chromium
bypasses `127/8`, `localhost` and `[::1]` for every proxy, silently. Passing
`--proxy-bypass-list=<-loopback>` removes that implicit bypass
(`browsers.out`):

| Chrome 153 | default | `<-loopback>` |
|---|---|---|
| `http://127.0.0.1:3000/` | bypassed | box: page and `fetch('/api')` |
| `http://localhost:3000/` | bypassed | box: page and `fetch('/api')` |
| `http://[::1]:3000/` | bypassed | box: page and `fetch('/api')` |

Chrome sends the target as a name (ATYP 3), even for a literal IP, so the
lookup happens at the proxy. For the real thing, that means the lookup
happens in the box, and compose-style names such as `db:5432` resolve there.

Edge accepts the same flags (`edge.out`: `localhost:3000` reached the box
four times, for the page, the `fetch` and the favicon). The Edge rows in
`browsers.out` are empty only because Edge's `--dump-dom` writes nothing to
a redirected stdout on Windows, not even for a `data:` URL. They do not
count as a result.

Firefox is untested. Its equivalents are the prefs
`network.proxy.allow_hijacking_localhost=true` and
`network.proxy.socks_remote_dns=true` in a `user.js` in a fresh profile.

**2. Branded Chrome cannot send a SOCKS5 username or password**
([crbug 40323993](https://issues.chromium.org/issues/40323993)). Since
Chrome 137 it also cannot load an extension from the command line to do it
([PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)).
So passwords cannot be the only way the proxy identifies a session.

**3. The connection's owner can stand in for the password.** For every
connection the listener looks up the process that holds the client end
(`GetExtendedTcpTable`, `TCP_TABLE_OWNER_PID_ALL`) and walks its parents
(`NtQueryInformationProcess`). Every Chrome and Edge connection traced to
the browser the spike had launched: the network-service child, then the
launched pid. Anything else showed up as `(not a launched browser)`.

**4. RFC 1929 works for clients that support it** (`curl.out`). The right
credentials reach the box; wrong ones are refused (curl exit 97). A
connection with no credentials from a process nobody launched was let
through *and logged*. The spike only observes this case. The real rule
refuses it.

## What this suggests for envmux

- **Where it lives:** in the envmux process, next to the portal on loopback.
  There is no daemon and no reverse proxy in the routing path. Closing envmux
  closes the listener. This is not what `archive/README.md` argues against,
  but it does make the zone, route, NRPT rule and session certificate
  optional for browser traffic. That is a design decision for the owner, not
  one this spike makes.
- **Identity:** each session gets its own listener port, pre-allocated. The
  port *names* the session; it does not *authorize* it. Any process of any
  local user can connect to a loopback port. Authorization, in order:
  1. SOCKS5 username/password when offered (curl, Firefox via policy,
     scripts). Username = session, password minted per run.
  2. Otherwise, the caller descends from a browser this envmux launched.
  3. Otherwise, the caller's process runs as this Windows user
     (`OpenProcessToken` → SID). This covers a browser the user pointed at
     the port by hand. Untested.
- **Profile:** one per session, under `~/.envmux/browsers/<session>` or a
  scratch directory, so cookies and storage for `localhost:3000` never leak
  between sessions. `http://localhost` is a secure context by origin, so
  service workers, `crypto.subtle` and clipboard should work without a
  certificate. Untested.
- **Traffic that isn't for the session:** Chrome's own calls (google.com,
  gstatic, updates) and any external URL the app loads also arrive at the
  proxy. The choice is between dialling them from the workstation and
  dialling them from inside the box (the browser sees the box's network).
  The spike refuses them. The real version must not.

## The exec half, built into envmux

This spike became `src/Envmux/Socks/` (see `docs/pages/browser.md`). It was
run on 2026-09-19 against the real host (Incus 7.0.1 on the LAN), with a
throwaway project whose only task was `python3 -m http.server 3000 --bind
127.0.0.1`, and `keepOnExit: false`:

- The instance was up about 4 s after start. The proxy claimed
  `127.0.0.1:1080` when the portal claimed its port.
- The route `http://socksdemo-….envmux:3000` failed: the server was bound to
  the guest's loopback. Through the proxy, `localhost:3000`, `127.0.0.1:3000`
  and `/api.json` all returned 200.
- `[::1]:3000` and `localhost:5000` were refused. Nothing was listening
  there, and the relay said so.
- **One exec per connection costs 37–67 ms** to a LAN host (from the
  session's own debug lines). curl's total for a page was 53–86 ms.
- `fonts.googleapis.com` and `fonts.gstatic.com` went out from the
  workstation in 26–36 ms (egress `local`).
- `POST /api/browser` opened Chrome 153 on its own profile. It was let in
  with no password because the session had launched it. The tab loaded
  `localhost:3000` (title `socksdemo`), made the `fetch`, and loaded the font.
  Chrome's own background traffic (update, optimisation guide, GCM on 5228)
  went out from the workstation.
- curl with no credentials was refused, and the log named it
  (`refused curl (pid …)`).
- Ctrl+C ended the session: port released, instance and empty branch
  removed.

Later the same day, with `tests/proof-of-life` (Vite 8, bound to the
guest's 127.0.0.1:5174): a websocket upgrade went through the relay (101,
then Vite's `{"type":"connected"}`), and the loading page answered while the
task waited on its install, then gave way to the app about 2 s after the task
restarted, in a real Chrome tab.

Not yet exercised: a long-lived stream, Firefox (not installed on this
machine), and many parallel connections. If per-connection cost matters, the next step is one
multiplexed exec per session.
