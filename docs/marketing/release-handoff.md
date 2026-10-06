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

Each published archive requires its actual native verification receipt from `scripts/check-desktop-archive.mjs` after packaging. It binds the extracted archive's exact digest to current installed resource hashes and native runtime checks. Private engine/session behavior is covered either by a matching new platform journey or explicit qualification of unchanged components against authenticated historical proof. Qualification compares the actual native assets, runtime implementation and dependency closure; it preserves the original proof's identity and time while binding its limited coverage to the new package. Receipts for prepared folders or another archive do not satisfy this check.

The catalog links a public package verification record beside each checksum. Its public copy omits the runtime journey’s local proof-directory path. All packages must match one publicly accessible source commit. Keep the catalog in `preparing` until the archive and runtime evidence are available; source implementation alone does not establish a shipped runtime.

### Corresponding runtime sources

After downloading the final approved release files and their passed archive receipts into one directory, assemble the exact specification without typing each target by hand:

```sh
node release/marketing/assemble-specification.mjs /absolute/path/to/final-release /absolute/path/to/release-specification.json
```

The assembly helper reads the repository version, requires Mac ARM64 and both Linux targets with matching runtime coverage, gathers each target's source archive and JSON, and checks the complete Ubuntu input set. Each target also needs `<platform>-<arch>.service.verification.json`, `<platform>-<arch>.gui.verification.json` and its `.png` screenshot. These bind the current bundle/source revision, native sandboxed frame, continued service health and actual service install/remove journey. Qualified 0.1.3 targets additionally supply their fresh `<platform>-<arch>.packaged-service-smoke.verification.json` inspection/API proof. A Mac candidate using a fresh runtime journey supplies `<platform>-<arch>.packaged-service-runtime.verification.json` for its installed service's runtime/session API journey. The specification includes these paths and hashes as `additionalVerificationArtifacts` for publication with the raw proof files.

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

It revalidates every public package receipt and its runtime coverage against the catalog, checks the complete runtime source catalog and public asset bytes, rebuilds the marketing pages, stages the real browser application, deploys with authenticated Wrangler and checks the public routes and release version. Verify the browser's actual connection journey and packages as well. Record the deployed version and checksums with the release.

## Verified access on October 5 2026

Official Wrangler refreshed the existing OAuth grant after the dashboard endpoint became reachable. Its account check succeeds, and authenticated API reads confirm the configured Enough account, the active `enoughtools.com` zone and existing Enough custom domains. The grant’s existing permissions remain unchanged.

The factory subdomain is not yet configured. No project, domain or DNS mutations were made during the access check. The release can use the established account and custom-domain deployment flow when the product artifacts are ready.

## Published release on October 5 2026

The authorized release is now public at [factory.enoughtools.com](https://factory.enoughtools.com). Cloudflare configured its custom domain during deployment. Worker `enoughfactory` serves the home page, guide, downloads, published catalog and actual shared browser application. All five HTTPS routes returned 200. The catalog exposes six unsigned 0.1.1 installer archives and thirteen runtime source files whose public bytes matched their local release artifacts. Mac packages are not notarized. [GitHub release](https://github.com/enoughtools/EnoughFactory/releases/tag/v0.1.1).

The initial deployment was `66323ecc-0742-4ebe-a1c7-003a46ab917f`. A browser-only onboarding correction is deployed in version `2ed99f20-da8d-4597-980f-5e028d98a541`: new visitors receive a clear device-connection prompt without requesting the marketing site's API or displaying an HTML error page. The web typecheck and staging build passed; browser assets changed without altering the static marketing pages, catalog or immutable desktop archives. Public installer and source bytes were not needlessly downloaded again.

The public download page and installation guide were inspected in a real browser, including the Mac DMG checksum and linked verification record. A clean visitor at the same deployment's alternate HTTPS origin received the corrected onboarding. Device execution remains owned by its installed service. See [the release ledger](../release-progress.md) for the final device-connection observation and its scope.

## Published 0.1.2

The final package source is frozen at `c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e`. All six native Mac ARM64/Linux x64/Linux ARM64 archives have fresh exact-byte runtime, sandboxed GUI and installed-service receipts; the Mac has its installed runtime/session API receipt. The new service data-boundary evidence is present on every target. The service SHA-256 is `a1e0efdfc322fcfd46cbc42a1d7649f5b92052128d9494d7aa6ed40181756bd7`, matching the [passed distributed journey](../verification/distributed-factory-evidence.json). Its [documented topology and scope](../verification/product-journey.md#paired-maclinux-factory-result-6-october-2026) retain the historical native-asset provenance and distinguish the deterministic approval fixture from the real Codex work.

Final local release assembly contains 41 package/source/proof files, with complete checksums and provenance alongside them. The exact selected Ubuntu index remains `70aae28ae71172ff64897506285cf2fd6963fe52bf648c430073ff7e7b63c81b`. Its seven audited files are reused only after unchanged guest-image/source closure and actual digest checks.

Delivery infrastructure after the package freeze lives on main. `stage-verified-release.yml` is a manual-only helper for the successful Linux run `37396429671`; it validates all four Linux archive bytes, strict runtime/GUI/service/data-boundary/source records and the selected Ubuntu members, then stages only 22 Linux files and seven Ubuntu files into the existing matching draft. It rejects mismatched existing assets and never publishes or replaces them. Mac assets remain owned by the release operator. [Staging run 37399027463](https://github.com/enoughtools/EnoughFactory/actions/runs/37399027463) passed; its 29-file receipt matched the final manifest and draft server digests. The release operator then published the exact [43-file GitHub release](https://github.com/enoughtools/EnoughFactory/releases/tag/v0.1.2), including checksums and provenance.

Creating the public tag triggered a redundant automatic native workflow, [run 37399569523](https://github.com/enoughtools/EnoughFactory/actions/runs/37399569523). The release operator canceled it; native/source jobs ended canceled and its publish job did not run. The successful frozen native run and manual staging result above remain the release evidence. No asset replacement occurred. The [public release metadata record](../verification/release-0.1.2-public.json) preserves all 43 server sizes/digests, the original draft staging receipt and cancellation result. The website's actual public-byte pass is recorded separately.

Source-identical compiled-asset reuse downloads permanent public `v0.1.1` archives/receipts and the selected Ubuntu set through `download-verified-baseline.mjs`, with the tag pinned to source `5252bd83a9082d7711e7e3dcbf426daef0abc165`. This avoids relying on expiring Actions storage. Changed native or Ubuntu source inputs retain the existing compile/reproduction path. Compiled-asset reuse alone does not qualify historical behavior.

For the 0.1.3 candidate, unchanged private engine/session coverage may be qualified against the published 0.1.2 proof only after exact component and source/dependency comparisons pass. Current package/archive checks, native sandboxed GUI, authenticated service inspection and login-service/data-retention journeys still run afresh. The new archive record must distinguish inherited coverage from these fresh results. Keep the 0.1.2 catalog and its immutable downloads in place until the complete new archive/source/proof set has been verified and published; this candidate description is not an availability claim.

Stage the new Linux delivery with `scripts/stage-verified-release.mjs --delivery <selection.json>`. The explicit selection contains `formatVersion: 1`, `version: "0.1.3"`, the frozen `sourceCommit`, actual successful `runId`, matching draft `releaseId`, current `serviceSha256`, and `jobIds`/`artifactIds` keyed by `arm64` and `x64`. Obtain these identities from the finished native run and new draft. The helper rejects the published 0.1.2 release, mismatched source or failed jobs, validates each exact archive and fresh proof, and uploads only missing assets to the selected draft. An existing mismatched asset fails staging rather than being replaced.

Keep downloaded CI files in `linux-arm64` and `linux-x64` directories beneath the staging directory. Supply an already verified local Ubuntu directory to reuse its bytes without downloading the unchanged source set again:

```sh
node scripts/stage-verified-release.mjs \
  --delivery /absolute/path/to/delivery-selection.json \
  --ubuntu-sources /absolute/path/to/selected-ubuntu-files \
  --stage /absolute/path/to/linux-staging \
  --report /absolute/path/to/draft-staging.verification.json
```

Run with authorized GitHub credentials and `GITHUB_REPOSITORY=enoughtools/EnoughFactory`. Staging preserves the draft state. The release operator adds the independently verified Mac archives and prepares the catalog only after the complete new release is public.

The actual public-byte pass completed once for all six installers and thirteen runtime source files. The marketing typecheck/build and hosted browser staging passed, followed by one direct Wrangler deployment. Cloudflare worker `enoughfactory` now serves [factory.enoughtools.com](https://factory.enoughtools.com) at version `d47f38f7-40a7-49f3-84d7-8ebf4cf9fcb4`.

All five HTTPS routes (`/`, `/docs`, `/downloads`, `/downloads/manifest.json` and `/app`) returned 200. The served catalog exactly matches the prepared file: published version 0.1.2, source `c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e`, six installers, thirteen sources and the selected Ubuntu index above. The guide includes its status-board link at the frozen source path. Packages remain unsigned, and Mac packages are not notarized. The [site verification record](../verification/release-0.1.2-site.json) preserves the results and actual browser observations.

The release operator inspected the live home page, all six download links and thirteen runtime source links, the Mac DMG checksum and native verification link, and the installation guide's actual status-board link. The current launch capture is [public-launch-0.1.2.jpg](../verification/public-launch-0.1.2.jpg). The user explicitly allowed Chrome's local-device permission; after accepting the prompt and refreshing, the hosted app connected to the empty isolated released 0.1.2 Mac service. The private engine remained stopped. The [connected workspace capture](../verification/public-workspace-connected-0.1.2.jpg) and site receipt preserve the observation.

For later releases, prepare the catalog once after publication, build marketing, stage the browser app and deploy directly with Wrangler. This sequence avoids the publisher wrapper's duplicate source streams. Check the five HTTPS routes and final catalog identity, record the actual deployment version, then freeze generated catalog and verification outputs for the release operator.
