# The zone

The workstation-side reachability envmux had until commit `ee2d15a` (*Open the
selected task in the session's browser, named and coloured*), retired in the
commit after it. Nothing here is built — it is outside `src/` and the project
globs do not reach it — and none of it is maintained. It is kept because it
worked, it was measured, and the reasons for each piece are in its comments.

## What it was

Every session's instance had an address on the host's bridge and a name under a
zone, `<project>-<session>.envmux`, and the workstation reached both directly:

- **A persistent route** for the range, to the machine Incus runs on — the VM's
  own address, or the Incus host's when envmux attached to one — added with
  `route.exe -p` because `New-NetRoute -PolicyStore PersistentStore` fails on
  Windows 11 26100. `envmux host wire` added it, `install` called that, and
  `host status` compared it with the `gateway` recorded in `host.json`.
- **An NRPT rule** sending `.envmux` to whatever answered the zone: the bridge's
  own dnsmasq on a VM envmux built, and on an Incus it attached to a small
  instance, **`envmux-util`**, whose dnsmasq forwarded the zone to the bridge's —
  because a query *to* the host's bridge address is a packet the host's firewall
  commonly drops, and a query *through* it to an instance takes the path every
  session's traffic takes. Its address was recorded as `resolver`.
- **A path check** at the end of an Incus install: one real DNS query for
  `envmux-util.<zone>` down the route it had just built, and a diagnosis naming
  the machine the silence came from — most often Docker's `FORWARD DROP` on the
  Incus host.
- **A wiring-conflict check** so that a second host on one workstation, or a
  swap from one host to another, could not silently take the first host's range
  or zone. `--force` was the swap.
- **A certificate authority** in `~/.envmux` (`envmux-ca.crt`, `envmux-ca.key`),
  a leaf issued per session for the names it answered on, written into the
  instance with `ENVMUX_TLS_*` and Kestrel's variables set, and `envmux ca` to
  put the root in this account's trusted store so `https://` on a session's own
  name opened with nothing clicked through.

## Why it went

The session now launches a browser whose `localhost` *is* the instance, through
a SOCKS5 port the session process holds on `127.0.0.1`, over an exec relay into
the instance (`src/Envmux/Socks/`, `docs/pages/browser.md`). That reaches a dev
server bound to the instance's own loopback, which the route never could, and it
needs no route, no DNS rule and no certificate — `localhost` is a secure context
by origin. The ssh alias the editor attaches with goes through the same relay
(`envmux relay`, the `ProxyCommand` in the block `envmux ssh` writes). With
nothing left on the workstation that resolves or routes, everything above was
machinery for a path nobody takes, and every one of its failure modes — a VPN
claiming the range, a catch-all NRPT policy, a host that does not forward, a
root that is not trusted — went with it. A host is now reachable from anywhere
its API is, which the route-based design could not offer.

## What is here

Files moved with `git mv`, so `git log --follow` reaches their history, at the
paths they had:

| Path | What it was |
|---|---|
| `src/Envmux/Host/Utility.cs` | `envmux-util`: creating it as a VM or a container, its dnsmasq, its pinned address, its status |
| `src/Envmux/Host/DnsProbe.cs` | A minimal DNS client for the path check — one A query, the response code, the addresses |
| `src/Envmux/Host/Authority.cs` | The root and the per-session leaf, and the current-user trust store on Windows |
| `src/Envmux/Session/SessionCertificate.cs` | Writing the leaf into the instance and the environment that named it |
| `src/Envmux/Commands/CaCommand.cs` | `envmux ca`, `--print`, `--remove` |
| `tests/Envmux.Tests/{Utility,DnsProbe,Authority,SessionCertificate,WindowsWiring}Tests.cs` | Their tests; `WindowsWiringTests` pinned the conflict decision and the printed script |
| `docs/pages/tls.md` | The user-facing page on the root, the leaf, and what a session got |

## What was cut from files that stay

Not duplicated here; `git show ee2d15a:<path>` has each of them whole.

- `src/Envmux/Host/Windows/WindowsNetwork.cs` — `WiringVerdict`, `WiringDecision`,
  `Decide`, `RecordedGateway`, `WireAsync`, `Script` (both), `WarningsAsync`,
  `Servers`, `SameAddress`, `Hop`, `Array`. Kept: `StatusAsync`, `UnwireAsync`
  (now unconditional, for the legacy clean-up), `Namespace`, `DestinationPrefix`,
  `Destination`, `Mask`, `SuggestCidrAsync`, `Overlaps`, `DhcpFor`.
- `src/Envmux/Commands/InstallCommand.cs` — `PathPatience`, the `Daemon` record,
  `IsOverlay`, `GatewayFrom`, `OverlayWarning`, `GatewayAsync`, `FreeToWireAsync`,
  `UtilityAsync`, `WireAsync`, `PathAsync`, `PathEvidence`, `PathDiagnosis`,
  `ApiPort`, `PingsAsync`, `CertificateAuthority`, the `--force` option, and the
  `resolver` handling in `Adopt` and `NetworkAsync`. Hyper-V went from 12 steps
  to 10, attaching to an Incus from 10 to 6.
- `src/Envmux/Commands/HostCommand.cs` — the body of `wire` (`--print`, `--force`),
  `WiringLinesAsync`, `UtilityLineAsync`, the `zone`/`gateway`/`root`/`route`/
  `nrpt`/`utility` lines of `status`, the gateway move in `trust`, and the
  utility rebuild and rewire in `range`.
- `src/Envmux/Host/HostConfig.cs` — `ResolverAddress`, the `gateway` and
  `resolver` checks in `Problems`, and `FirstFreePinned` reserving the resolver.
  The two properties stay so a `host.json` an older envmux wrote still parses.
- `src/Envmux/Host/Windows/Provisioning.cs` — elevation for the Incus provider,
  which only the wiring needed.
- `src/Envmux/Program.cs` — `ca` and `--remove`; the `tls` line of `--dry-run`
  no longer reads the trust store.
- `src/Envmux/Session/Session.cs` — `IssueCertificateAsync` and the `_tls`
  environment it produced.

## If it ever comes back

Read `Utility.cs`'s class remarks first: the to-versus-through distinction is
the whole reason the utility instance existed, and it is not obvious. Then
`WindowsNetwork.Decide` in `git show ee2d15a:src/Envmux/Host/Windows/WindowsNetwork.cs`
— refusing to steal another host's wiring was learned the hard way, on a swap.
