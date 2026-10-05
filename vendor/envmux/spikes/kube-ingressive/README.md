# kube-ingressive spike — a public site per workspace, through Ingressive

Supersedes [`kube-hub`](../kube-hub): instead of a hub we run — LoadBalancer IP,
CoreDNS, nginx terminating mTLS — the cluster runs the
[Ingressive](https://ingressive.cloud) controller, and each envmux workspace
route is one `Ingress` whose host is a name under a domain connected to the
Ingressive account. Ingressive does DNS, certificates and the edge; the
connector it pairs with the controller **dials out**, so the cluster opens no
port and needs no public IP at all.

**Proven live on 2026-09-03** against `devclusta-xl-01` with the domain
`its.matto.dev`: `verify.sh` all green.

| claim | result |
|---|---|
| controller installs from `.context/ingressive` as written | checks in as `dev`, reconciles paired connector `dev-controller`, both Running in ~15 s |
| an `Ingress` with `ingressClassName: ingressive` becomes a site | "site created", hostname written to the Ingress `ADDRESS` |
| the site is live on the public internet with a browser-trusted certificate | **63 s** from `kubectl apply` to the first 200; Let's Encrypt `*.its.matto.dev` |
| two workspaces on port 3000 do not collide | `envmux-probe-a` and `envmux-probe-b` both `:3000`, each its own hostname |
| a second route of one workspace | `envmux-probe-a-docs.its.matto.dev` → `:5173` |
| WebSocket through the edge (HMR) | `101 Switching Protocols` |
| a hostname whose domain is not connected | site is **created** by the API but the edge answers `404 Site is not configured in Bifrost` — connection of the domain is the gate, not site creation |
| a hostname that is not a public domain (`.invalid`) | API refuses: `site_id must be a valid public domain` |

## What the controller does (from its source, `.context/connector` and the controller repo)

- On start: `POST /controller/check-in` with the account API key (SigV4-style,
  region `global`, service `api`), then creates one paired **connector**
  Deployment per namespace with its own access key and a Ziti enrollment JWT.
  The connector holds a WebSocket to `console.ingressive.cloud/connectors/ws`
  and hosts its HTTP service on the OpenZiti overlay — that is the outbound
  channel traffic comes back over.
- On each `Ingress`: `PUT /sites/<host>` with `{ "config": { "locations": [
  { "type": "prefix", "path": "/", "upstream": { "connector_id", "service":
  "http://<svc>.<ns>.svc.cluster.local:<port>" } } ] } }`, and `PUT
  /connectors/<slug>/services` with the allowlist of upstream URLs. Console
  edits to fields the Ingress does not set are preserved (cooperative merge).
  Deleting the Ingress deletes the site.
- Annotations honoured: `nginx.ingress.kubernetes.io/{rewrite-target,
  proxy-body-size, proxy-*-timeout}` and `ingressive.cloud/security-headers`.
  Nothing else — deliberately.
- A `SiteLocation` also carries `shield_id`, `edge_cache_*`, request/response
  headers, which the controller does not set. Those are the console's, or ours
  through the same API.

## Running it

```sh
export KUBECONFIG=Z:/envmux/.context/devclusta-xl-01-kubeconfig.yaml
sed 's/\r$//' .context/ingressive | sh        # once: namespace, credentials, helm install
cd spikes/kube-ingressive
DOMAIN=its.matto.dev sh deploy.sh
DOMAIN=its.matto.dev sh verify.sh             # about a minute after deploy
sh cleanup.sh                                 # leaves the controller installed
```

Nothing is needed on the workstation: no CA, no NRPT, no client certificate,
no port-forward. A browser anywhere opens `https://envmux-probe-a.its.matto.dev/`.

## What this changes in envmux's design

**Route = hostname, not port.** Ingressive is HTTP on 443. "Two sessions both
bind 3000 and neither moves" still holds — they are two pods — but what a
person opens is `https://<project>-<session>-<route>.<domain>/`, not
`:3000`. The URL-pin path already rewrites what a dev server prints
(`localhost:5173`) onto the route's hostname, so that composes.

**Access control is Ingressive's, not ours.** Shield offers password-protected
routes and JavaScript/captcha challenges today, SSO is planned; there is no
client-certificate option. The portal keeps its own token as before; a
workspace's dev servers are as private as their Shield config. The mTLS
design in `kube-hub` does not carry over — and is not needed for the routes
that were always meant to be reachable.

**Onboarding for the kube backend gains two facts, not steps envmux performs:**
an Ingressive account with a connected domain, and the controller installed
(the recipe is three commands). envmux verifies both by creating a probe
Ingress and waiting for the first 200, exactly as `verify.sh` does.

## Left to check

- `Ingress` per route is many sites for a busy session; whether Ingressive has
  a limit per account, and how fast `to_delete` reconciles when a session ends.
- Source IP and identity headers reaching the pod — not observed; the echo
  server showed `Server: nginx` from the edge and nothing else was inspected.
- Programmatic Shield: `shield_id` on a location through the same
  `PUT /sites/<host>` envmux could make directly, so a route can be
  password-protected from `.envmux.json`. Not tried.
