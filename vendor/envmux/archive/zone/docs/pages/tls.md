# TLS

Every session answers on a name of its own, and gets a certificate for it.

```console
$ envmux ca
  root    ~/.envmux/envmux-ca.crt (created)
  name    envmux local development root
  sha256  cb4ab14c1384c0ab8bb0d7d44d383609ee1a0c68c5877d804472c4ccb3239200
  expires 2036-08-24
  store   added to this account's trusted roots
```

Once, on this workstation. After that
`https://myproj-feat-login.envmux:15260` opens with a padlock and no
click-through, and so does every other session on the machine.

## Why this exists at all

Under Docker it did not have to. Everything came back on `localhost`, and every
browser treats loopback as a secure context whatever the scheme — so plain HTTP
was enough for a service worker, for `crypto.subtle`, for a `Secure` cookie, for
anything that checks.

An address of its own takes that exemption away. `myproj-feat-login.envmux` is an
ordinary hostname as far as a browser is concerned, and over `http://` it is an
ordinary insecure origin. The thing that made the routing simple is the thing
that made the certificate necessary, and there is no version of "one address per
session" that avoids it.

So envmux does the same trick it already does for the host, in the other
direction.

| | The host's certificate | The session's |
|---|---|---|
| Made | on this machine | on this machine |
| Trusted by | the IncusOS host, from the seed, before it boots | this workstation, from `envmux ca`, once |
| Proves | that this client is envmux | that this session is the name it claims |
| Never leaves | the workstation (the key) | the workstation (the root's key) |

Neither direction exchanges a token, and neither has a moment where something
untrusted is talking to something else. The one exception is a host envmux did
not build: an Incus you already run was never seeded, so its trust is one token
from `incus config trust add envmux`, pasted once at install. The session's
column is the same on both.

## What is where

```
~/.envmux/envmux-ca.crt      the root: public half, and what `envmux ca` trusts
~/.envmux/envmux-ca.key      its key. This never leaves the machine.
```

Inside every session's instance, written as it starts:

```
/etc/envmux/tls/ca.crt         the root's public half
/etc/envmux/tls/session.crt    the leaf, for this session's names
/etc/envmux/tls/session.key    its key
/etc/envmux/tls/fullchain.crt  leaf + root, for a server that wants a chain
/etc/envmux/tls/session.pfx    all of it as PKCS#12, for .NET
```

and the root is copied to `/usr/local/share/ca-certificates/envmux-root.crt`
with `update-ca-certificates` run over it — so OpenSSL, curl, git and .NET
*inside* the instance believe it too. That second half matters more than it
looks: most of what a session serves over TLS also talks to itself over TLS, and
without it every one of those paths needs validation turned off.

## The leaf

Signed for the names this session actually answers on, and nothing else:

- `myproj-feat-login.envmux` — the session
- `myproj-feat-login-db.envmux` — each declared [service](services.md)
- `localhost`, `127.0.0.1`, `::1` — because a session's processes reach each
  other over loopback
- the instance's address on the bridge

**No wildcard over the zone.** A leaf good for `*.envmux` would be one session
able to impersonate every other, sitting in a container running whatever that
project's lockfile pulled in. The names are known before the session starts, so
there is nothing to gain by widening them.

Thirteen months, and reissued every time the session starts. The root is a
decade, because rotating it means visiting a trust store.

## What a session reads

Written into the environment every shell in the instance sees:

```console
ENVMUX_TLS_CERT=/etc/envmux/tls/session.crt
ENVMUX_TLS_KEY=/etc/envmux/tls/session.key
ENVMUX_TLS_CHAIN=/etc/envmux/tls/fullchain.crt
ENVMUX_TLS_PFX=/etc/envmux/tls/session.pfx
ENVMUX_TLS_PASSWORD=…                      # the PKCS#12 password, per session
ENVMUX_TLS_CA=/etc/envmux/tls/ca.crt
ENVMUX_HOSTNAME=myproj-feat-login.envmux   # what the certificate is for

Kestrel__Certificates__Default__Path=/etc/envmux/tls/session.pfx
Kestrel__Certificates__Default__Password=…
NODE_EXTRA_CA_CERTS=/etc/envmux/tls/ca.crt
```

The `ENVMUX_TLS_*` half is the general answer — paths, named after what is at
them, for a Caddy or an nginx template or a `vite.config.ts` to point at:

```ts
server: {
  https: { cert: readFileSync(process.env.ENVMUX_TLS_CERT!),
           key:  readFileSync(process.env.ENVMUX_TLS_KEY!) }
}
```

`Kestrel__Certificates__Default__*` is the one framework-shaped exception, and it
earns it by being free. Every ASP.NET Core application reads unprefixed
environment variables into its configuration, so **a .NET server in a session
serves this session's certificate with no code and no configuration** — an API,
an Aspire dashboard, a Blazor app. Nothing that is not ASP.NET Core reads those
two names, so a project that is not .NET pays nothing for them being set.

`ENVMUX_HOSTNAME` is there because `env` values in `.envmux.json` are literal,
with no interpolation, so a task that has to name its own session has to read it
from a shell that already knows:

```jsonc
{ "tasks": { "app": { "command": "PUBLIC_URL=\"https://$ENVMUX_HOSTNAME:3000\" npm start" } } }
```

## Saying a route is TLS

envmux has nothing in the connection path, so it cannot observe which of your
servers speaks TLS. It has to be told:

```jsonc
{
  "routes": {
    "vite": 5173,
    "dashboard": { "port": 15260, "tls": true }
  }
}
```

That changes the URL in the window, in the portal and in `envmux code` from
`http://` to `https://`. It is not a translation — the port is still the port
the server bound — it is the scheme that server actually speaks.

## Turning it off

```jsonc
{ "tls": false }
```

Writes nothing to `/etc`, sets none of the variables above, and leaves the
session exactly as it was before this existed.

## What `envmux ca` does, exactly

Two things, both idempotent:

- **Makes the root**, if it is not there. This happens on its own the first time
  any session starts — it is a file in envmux's own directory and it does
  nothing until something trusts it.
- **Adds it to the current user's trusted roots**, which is the part that asks.
  The *current user's*, not the machine's: no elevation, and nobody else who
  logs into this workstation is affected.

That covers Chrome, Edge, `curl` through SChannel, and .NET. **Firefox and Java
keep stores of their own and are not covered** — `envmux ca --print` writes the
certificate out for importing into one.

`envmux ca --remove` takes it back out. The file stays and sessions keep using
it, so a browser starts warning again; delete `~/.envmux/envmux-ca.crt` to stop
signing with it altogether.

Adding a certificate authority is the only thing envmux does that changes what
this whole machine will believe, from anywhere, until it is taken back out.
That is why it is a command you run rather than something a session does on your
behalf, and why `envmux install` asks before doing it — the same treatment
`~/.ssh/config` gets, for the same reason.

## Windows only, so far

`envmux ca` writes a trust store on Windows. On macOS and Linux it prints the
command for the store it cannot write:

```console
  macOS  security add-trusted-cert -d -k ~/Library/Keychains/login.keychain-db ~/.envmux/envmux-ca.crt
  Linux  sudo cp ~/.envmux/envmux-ca.crt /usr/local/share/ca-certificates/envmux-root.crt
         sudo update-ca-certificates
```

Everything inside the instance works either way; it is only what this
workstation's browser believes that needs the step.
