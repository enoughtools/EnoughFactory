# Routing

There is no routing. That is the point of this page, and it is shorter than it
used to be.

An instance has an address of its own on the host's bridge, and every port a
dev server binds inside it is that server's own port. Nothing publishes it,
nothing proxies it, nothing rewrites a `Host` header, and nothing on this
workstation routes to the range or resolves the zone.

## How a session is reached

**Through the browser it opens.** Press `b`, or `enter` on a task or a route,
and a browser opens whose `localhost` *is* the instance: `http://localhost:5173/`
is port 5173 inside the session. It reaches a server bound to the instance's own
`127.0.0.1` too, which no route ever could. The session holds a SOCKS5 port on
`127.0.0.1` and carries each connection into the instance over an exec on the
host's API; the rest of the web leaves from this machine as usual. `localhost`
is a secure context, so a service worker, `crypto.subtle` and a `Secure` cookie
work over plain http with no certificate anywhere.
[Browser](browser.md) is the whole of it.

**Through ssh, by name.** `myproj-feat-login.envmux` is an ssh alias: the
`Host *.<zone>` block `envmux ssh` writes gives it a `ProxyCommand`,
`envmux relay`, which opens the instance's port 22 from inside the instance over
the same API. That is what the editor's Remote-SSH attach uses. See
[`envmux ssh`](cli.md#envmux-ssh).

**From the portal.** The session in a browser tab, on a loopback port this
process holds, behind a per-session token. See [Portal](portal.md).

Both of the first two go through the host's REST API and nothing else, so a
host is usable from anywhere its API is reachable — a LAN, an overlay, or one
port open across the internet. There is no next hop to arrange and no
forwarding on the host to get right for the workstation's sake.

## What this replaces

Two generations of machinery, both gone.

Under Docker on Windows every environment was flattened onto the host's port
space, and envmux undid that with a reverse proxy on a claimed loopback port, a
hostname per route, a relay binary in each container, a port allocation table
and a `Host` rewrite. Giving each instance an address removed all of it.

Then the workstation reached that address directly: a persistent route for the
range to the machine the bridge is on, an NRPT rule resolving `*.envmux` at the
bridge's dnsmasq — or, on an Incus you already ran, at a small `envmux-util`
instance, because a query *to* a host is dropped where a query *through* it is
forwarded — a path check at the end of install, a wiring-conflict check so a
second host could not steal the first one's range, and a certificate authority
so `https://` on a session's own name opened without a warning. Every one of
those existed to make a name on this workstation reach a port on the instance,
and the browser proxy does that with none of them. They are under
[`archive/zone/`](https://github.com/envmux/envmux/tree/main/archive/zone)
with their reasons.

A workstation set up by that version still has its route and its NRPT rule;
`envmux host unwire` takes them off, and `envmux host status` says when they are
there.

## The `Host` header, and binding

In the session's browser a server sees `Host: localhost:5173`, which every dev
server's allowlist already accepts. A server that generates absolute URLs
generates `localhost` ones, and they are right in that browser.

A server bound to `127.0.0.1` inside the instance is reachable from the
session's browser and from ssh. There is no longer a reason to make it bind
`0.0.0.0` for envmux's sake.

## The zone

`dnsDomain` in `host.json` — `envmux` by default, or an adopted network's own
`dns.domain` — is the suffix of a session's ssh alias, and what the bridge's
dnsmasq answers for *inside* the instances, where a session reaches its own
services by name. Nothing on this workstation resolves it. See
[Services](services.md) for the names a session sees from inside.

## The ports envmux claims

Two, both on loopback, both held by the session process and released when it
exits: the [portal](portal.md)'s (`port`, 8080 by default) and the
[browser](browser.md)'s SOCKS5 port (`browser.port`, 1080 by default). The bind
is the claim; there is no lockfile and no registry.

## WebSockets

They work through the browser proxy, and there is nothing to say about it.
Vite's hot reload connects.

## What is not here

**Reaching a session from another machine, or from a browser envmux did not
open.** The browser proxy admits a browser the session launched, or a client
that sends the session's SOCKS5 password; nothing else. There is no address on
this workstation that stands for the session, on purpose: nothing authenticates
what a session serves.

**A host that cannot dial the workstation.** The room a
[remote agent](agents.md#the-transport) talks through is an Incus proxy device,
which has the Incus host open a connection *to* this machine. On a LAN it can;
through NAT, or an overlay that admits one direction only, it cannot. Sessions,
the browser, the editor and the portal do not depend on it; the room does, and
it waits for the tunnel in
[the backends plan](https://github.com/envmux/envmux/blob/main/docs/backends.md).
