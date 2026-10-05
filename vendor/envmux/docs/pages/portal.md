# Portal

**The session in a browser tab, on the port it already claimed.**

Press `p`. A page opens showing the same session the terminal window is
showing — the routes, the tasks and what they are saying, the log — and the
things the window cannot give you from another machine's browser: a task's
output followed live, as many shells in the instance as you care to open, and a
button that drops you straight into whichever coding tools the session mounted.

```console
$ envmux feat-login
...
09:41:06  portal → http://127.0.0.1:8080/?k=ffuvU683LiHJbmuUdlz20Zua
```

That link is the whole of it. It is printed when the port is claimed, printed
again by `/portal`, and listed by `/status` beside the routes.

It is also *in* the routes. The portal is listed first, under the name
`envmux`, in the window's routes pane and in the page's own sidebar — with the
key on the URL, because a link without it is a link that asks for a token. `o`
on that row, or `/open envmux`, opens it.

## What it is not

It is not a service, a daemon, or a second process. It is a handful of
endpoints on the router that is already running in `envmux` — the same YARP
listener the routed hostnames arrive on, and the same `Session` object the
terminal window is drawn from. When the session ends, so does the page.

The archive had a portal: a Vite app talking to a resident daemon over its own
HTTP transport, with its own state, its own auth and its own release. That one
was [deliberately dropped](https://github.com/envmux/envmux/tree/main/archive).
This one costs a port that was already claimed, a process that was already
running, and a page that is already inside the executable.

## Where it answers

Two names, both reaching the same listener:

| | |
|---|---|
| `http://127.0.0.1:{port}/` | needs no DNS, and always works |
| `http://{project}-{session}.{domain}:{port}/` | the routed scheme with the route label taken off |

The second is a name no route can collide with — a route called `web` is
`{project}-{session}-web`, and there is no route name that makes the delimiter
before it disappear.

Everything else on that port is a route, and a route is untouched: the portal's
own paths are mapped on its loopback hostnames only, so an instance serving
`/api/state` still serves it on *its* hostname.

## Loopback, and a token

**The listener is bound to `127.0.0.1`.** That is the whole design — one port,
on loopback, held as the claim — so the portal is reachable from this machine
and from nowhere else without saying anything in the config.

**A token is asked for anyway**, and it is on by default. Loopback is not a
boundary between you and the rest of what is running on this machine: every
other process on this machine, and anything that can reach its loopback,
can reach a bound loopback port too — and this one hands out a shell in your
container.

The token is minted per session, never written to disk, and dies with the
process. It goes into the URL once, is traded for a cookie, and is then taken
out of the address bar — so what gets bookmarked, screenshotted or pasted into
an issue has no secret in it. A bookmark from yesterday asks for a new token
today, which is what a per-session secret means.

```jsonc
{
  "portal": {
    "enabled": true,   // default: on
    "token": true,     // default: on
    "open": false      // default: off — true opens a browser when the session starts
  }
}
```

`"token": false` serves it to anything on this machine that can reach the port.
That is a real choice with a real cost, and the log says so every session it is
taken.

## The page

Identity across the top, three lists down the side, and one big pane with tabs.

**Routes** are links, and the first of them is `envmux` — this page, tagged
`portal` and carrying the key, so the address to send yourself is one copy
rather than a scroll back through the log. **Services** are named with the host
and port the session reaches them on — and no passwords: the session is told
those, and a browser tab has no use for them.

**Tasks** show their state and the last thing they said. Hovering one offers
restart, stop and start, which call straight back into the session — the same
methods the `k` key and `/task restart` reach. A task restarted from a browser
tab and one restarted from the window are the same act, and both show up in
both places a moment later.

Clicking a task's name opens **its output**, followed from the beginning: the
backlog envmux has kept and then every line as it arrives. Read-only in the
strong sense — there is no pty on the other end and nothing to type into. This
is the tail you leave open on a dev server.

**`+ shell`** — and `+ claude`, and a button for every other mounted tool —
opens a real terminal in the instance: an interactive exec with a pty, spliced to the
tab over a websocket, as the same non-root account the session made and in the
same working directory. `top`, `vim`, colours, `^C` and a
terminal that resizes with the window all work, because it is a pty rather than
a command runner.

## A button per tool

Every [tool](configuration.md#fields) the session mounted gets its own button
beside `+ shell` — `+ claude`, `+ codex` — and clicking one opens that tool
rather than a shell:

```jsonc
{ "tools": { "claude": "auto", "codex": "auto" } }
```

That is the shortest path to the thing mounting a tool is *for*. Its state came
from your machine, so it opens signed in, in the session's checkout, in a real
terminal.

The tool is `exec`'d, so it is the process the terminal is attached to: quitting
it ends that shell, the way quitting `claude` in a terminal does. It is started
through a login shell with `~/.local/bin` on the `PATH`, which is where a tool
installed by its own installer inside the instance ends up.

Only tools there is something to open get a button. `gh` does not: mounting it
means `git push` is authenticated, and running `gh` on its own prints usage and
exits. And only tools that were **actually mounted** — a tool set to `"auto"`
with no state on this host resolves to nothing, and a button offering to open a
tool that is not signed in would be a lie.

Mounting a tool's state says nothing about whether the *image* has it installed.
Where it does not, the terminal says so and hands you a shell instead of closing
a second after it opened.

## Shells last as long as their tab

One socket is one shell. Opening a tab creates it, closing the tab ends it, and
two tabs are two shells because they are two sockets. There is nothing on the
far side holding one open between connections, by design: envmux is the process
you are looking at, and a shell that outlived it would outlive the container it
was in.

When a shell ends — you typed `exit`, or the command in it died — the terminal
says what it exited with, keeps everything above it, and offers another in the
same tab.

## Turning it off

```jsonc
{ "portal": { "enabled": false } }
```

The port then answers as it did before there was a portal: a plain page listing
the routes.

## Building it

The page is React, TypeScript and [xterm.js](https://xtermjs.org), built by Vite
into one bundle and carried inside the executable as an embedded zip — so an
installed `envmux` serves it without a directory beside it, which a single file
on a `PATH` cannot assume it has.

`dotnet build` builds it when Node is on `PATH` and skips it when there is none:
a working tree without Node still builds, still runs and still routes, and the
page it cannot serve says exactly that. See
[Development](development.md#the-portal-page) for working on it.
