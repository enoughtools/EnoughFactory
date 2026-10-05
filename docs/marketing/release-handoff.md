# EnoughFactory marketing release

The release site lives in `apps/marketing` and targets [factory.enoughtools.com](https://factory.enoughtools.com). It uses the existing Enough Cloudflare account and the same Workers assets deployment pattern as EnoughUI and the Enough brand site.

## Site and build

The React site uses EnoughUI, supplied local brand assets and fonts. Its home page, guide and downloads are prerendered into static HTML with route-specific metadata. The release catalog controls download availability and source links.

From the repository root:

```sh
pnpm --filter @enoughfactory/marketing build
pnpm --filter @enoughfactory/marketing preview
```

The local preview runs at `http://127.0.0.1:4174`. The site can also be hosted as ordinary static output from `apps/marketing/dist`.

## Real release artifacts

`public/downloads/manifest.json` begins in the `preparing` state with no artifact links. To prepare a published catalog, supply a JSON specification to:

```sh
node release/marketing/prepare-release.mjs /absolute/path/to/release-specification.json
```

The specification contains `product`, `version`, `status`, the actual public `sourceUrl`, and an `artifacts` array. Each artifact supplies its local `path`, `platform` (`darwin` or `linux`), `arch` (`arm64` or `x64`), `format`, accurate `signing` (`signed` or `unsigned`), and an optional HTTPS `url` for its published download. Paths are relative to the specification file.

The preparation step hashes actual nonempty local files, records their sizes and checks any supplied checksum. A published catalog requires Apple Silicon Mac, Linux x64 and Linux ARM64 packages, an accessible source repository and external downloads whose actual contents match the local artifacts. Files larger than 25 MiB need a real external release URL because they exceed the Workers individual asset limit. Small local downloads can be copied into the site. [Workers asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets).

Rebuild the site after updating the manifest. The prerendered download page and embedded initial state will then match the release catalog.

## Hosted browser application

After the marketing build, stage the current shared web application:

```sh
node release/marketing/stage-browser-app.mjs
```

This builds the actual `apps/web` source with `/app/` asset paths and copies it into `apps/marketing/dist/app`. Run it after the final marketing build because the marketing build replaces its output directory. The app route receives a separate connection policy for configured HTTPS/WSS peers and loopback device services; the presentation pages permit only same-origin connections.

Verify the browser’s connection and pairing journey against the real device service before release. The marketing worker serves the interface and static assets; it does not become the coordinator or local execution service.

## Hosting

`apps/marketing/wrangler.jsonc` configures worker `enoughfactory`, existing account `2b770eb5992d931c6468f98024f8f5b7`, static assets and the custom domain. Its small worker adds response headers and avoids caching the release catalog. Cloudflare’s custom-domain setup creates the domain’s DNS record. [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [static assets](https://developers.cloudflare.com/workers/static-assets/).

Use the release command after the complete product release and its published catalog are ready:

```sh
pnpm --filter @enoughfactory/marketing deploy
```

It rebuilds the marketing pages, stages the real browser application, deploys with authenticated Wrangler and checks the public routes and release version. Verify the browser’s actual connection journey and packages as well. Record the deployed version and checksums with the release.

## Verified access on October 5 2026

Official Wrangler refreshed the existing OAuth grant after the dashboard endpoint became reachable. Its account check succeeds, and authenticated API reads confirm the configured Enough account, the active `enoughtools.com` zone and existing Enough custom domains. The grant’s existing permissions remain unchanged.

The factory subdomain is not yet configured. No project, domain or DNS mutations were made during the access check. The release can use the established account and custom-domain deployment flow when the product artifacts are ready.
