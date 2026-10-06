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

The specification contains `product`, `version`, `status`, the actual public `sourceUrl`, and an `artifacts` array. Each artifact supplies its local `path`, `platform` (`darwin` or `linux`), `arch` (`arm64` or `x64`), `format`, accurate `signing` (`unsigned` for the initial packages), an actual extracted-package `verificationPath`, and an optional HTTPS `url` for its published download. Paths are relative to the specification file. An optional `sourceCommit` must match every package receipt. The format must match the filename and actual extraction record. Signed catalog claims require native signing verification to be implemented first.

The preparation step hashes actual nonempty local files, records their sizes and checks any supplied checksum. A published catalog requires Apple Silicon Mac, Linux x64 and Linux ARM64 packages, an accessible source repository and external downloads whose actual contents match the local artifacts. Files larger than 25 MiB need a real external release URL because they exceed the Workers individual asset limit. Small local downloads can be copied into the site. [Workers asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets).

Each published archive also requires its actual native verification receipt. Generate it with `scripts/check-desktop-archive.mjs` after packaging. The receipt binds the extracted archive’s exact digest to verified installed resource hashes, native runtimes, the private engine’s pinned assets and an actual platform runtime journey. The journey must match the archive’s bundle provenance, runtime assets, envmux executable and release source commit. Receipts for prepared folders or another archive do not satisfy this check.

The catalog links a public package verification record beside each checksum. Its public copy omits the runtime journey’s local proof-directory path. All packages must match one publicly accessible source commit. Keep the catalog in `preparing` until the archive and runtime evidence are available; source implementation alone does not establish a shipped runtime.

### Corresponding runtime sources

After downloading the final approved release files and their passed archive receipts into one directory, assemble the exact specification without typing each target by hand:

```sh
node release/marketing/assemble-specification.mjs /absolute/path/to/final-release /absolute/path/to/release-specification.json
```

The assembly helper reads the repository version, requires Mac ARM64 and both Linux targets with matching native runtime receipts, gathers each target’s source archive and JSON, and checks the complete Ubuntu input set. Each target also needs `<platform>-<arch>.service.verification.json`, `<platform>-<arch>.gui.verification.json` and its `.png` screenshot. These must bind the same bundle/source revision, native sandboxed frame, continued service health, and actual service install/remove journey. The Mac candidate also supplies its actual `<platform>-<arch>.packaged-service-runtime.verification.json` proving the installed service’s runtime/session API journey. The specification includes those paths and hashes as `additionalVerificationArtifacts` for publication with the raw proof files; this does not add another public catalog schema.

The helper writes only a specification. The preparation step still verifies actual package and source bytes and public availability before changing the catalog. Use `--ubuntu-sources /absolute/path/to/final-ubuntu-files` when the seven final Ubuntu files are kept separately.

For 0.1.2 and later, the installed-service receipt also requires `dataBoundary` evidence bound to the same source, bundle manifest, installed service and bundled Node hashes. It must retain the known legacy record and event at cursor 41 through migration, resource update/restart and normal removal, preserving access/device identity and a monotonic persistent cursor. Newer-schema and malformed-baseline child startups must exit unsuccessfully before opening a listener or creating a connection record, with identical database bytes before and after. Historical 0.1.1 receipts keep their original lifecycle gate; they do not acquire these new claims retroactively.

The published specification also supplies `releaseBaseUrl`, such as `https://github.com/enoughtools/EnoughFactory/releases/download/v0.1.1`, and `sourceArtifacts: [{ "path": "releases/EnoughFactory-0.1.1-darwin-arm64-container-sources.tar.gz" }, { "path": "releases/EnoughFactory-0.1.1-darwin-arm64-container-sources.tar.gz.json" }]`. Supply the archive and JSON for every packaged platform/architecture. These paths are relative to the specification file; the filename and hash must match each archive receipt’s embedded `containerRuntime.engineSourceBuild.sourceCompanion`. A supplied source `url` must equal its filename beneath the actual release base.

Ubuntu files default to `dist/ubuntu-source-companion`. An optional `ubuntuSourceDirectory` selects another directory relative to the specification file, including the final files downloaded from CI. Preparation reads the actual index and hashes its listed source parts, archive evidence, lock, index, README and checksums. The current release requires all seven files. The index must cover every package in the audited source lock, and its image hashes must match the verified bundled Mac guest. Regenerated archive hashes are taken from the final index and files; prior local gzip hashes are not assumed.

Publish these companions as public assets on the same GitHub release before preparing the catalog. The preparer streams the public bytes and verifies their exact hashes and sizes. The publisher repeats this check before deploying executable download links. A missing, unavailable or mismatched source asset prevents publication. The `sources` catalog entries contain their kind, role, filename, public URL, hash, size and target when applicable. The downloads page exposes engine source archives/build records and every Ubuntu companion file; the guide links to that section.

Keep all corresponding source assets available for as long as the executable packages are distributed. The catalog’s combined `SHA256SUMS.txt` includes installers and source assets.

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

It revalidates every public package receipt and its runtime journey against the catalog, checks the complete runtime source catalog and public asset bytes, rebuilds the marketing pages, stages the real browser application, deploys with authenticated Wrangler and checks the public routes and release version. Verify the browser’s actual connection journey and packages as well. Record the deployed version and checksums with the release.

## Verified access on October 5 2026

Official Wrangler refreshed the existing OAuth grant after the dashboard endpoint became reachable. Its account check succeeds, and authenticated API reads confirm the configured Enough account, the active `enoughtools.com` zone and existing Enough custom domains. The grant’s existing permissions remain unchanged.

The factory subdomain is not yet configured. No project, domain or DNS mutations were made during the access check. The release can use the established account and custom-domain deployment flow when the product artifacts are ready.

## Published release on October 5 2026

The authorized release is now public at [factory.enoughtools.com](https://factory.enoughtools.com). Cloudflare configured its custom domain during deployment. Worker `enoughfactory` serves the home page, guide, downloads, published catalog and actual shared browser application. All five HTTPS routes returned 200. The catalog exposes six unsigned 0.1.1 installer archives and thirteen runtime source files whose public bytes matched their local release artifacts. Mac packages are not notarized. [GitHub release](https://github.com/enoughtools/EnoughFactory/releases/tag/v0.1.1).

The initial deployment was `66323ecc-0742-4ebe-a1c7-003a46ab917f`. A browser-only onboarding correction is deployed in version `2ed99f20-da8d-4597-980f-5e028d98a541`: new visitors receive a clear device-connection prompt without requesting the marketing site's API or displaying an HTML error page. The web typecheck and staging build passed; browser assets changed without altering the static marketing pages, catalog or immutable desktop archives. Public installer and source bytes were not needlessly downloaded again.

The public download page and installation guide were inspected in a real browser, including the Mac DMG checksum and linked verification record. A clean visitor at the same deployment's alternate HTTPS origin received the corrected onboarding. Device execution remains owned by its installed service. See [the release ledger](../release-progress.md) for the final device-connection observation and its scope.
