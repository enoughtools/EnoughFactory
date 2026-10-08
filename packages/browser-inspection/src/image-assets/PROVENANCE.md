# Chromium tooling provenance

Resolved from publisher sources on 8 October 2026. The runtime never resolves tags.

- Publisher: Microsoft; package license Apache-2.0, retained in `LICENSE.playwright-mcp`.
- Official Chromium-only image: <https://github.com/microsoft/playwright-mcp/blob/v0.0.82/Dockerfile>.
- OCI index: `mcr.microsoft.com/playwright/mcp@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734`.
- amd64 manifest: `sha256:a8e5493fa6fd055e9d441fe69cf38069b5e32231ca7ab5aafcc51bf08ef619a5`; compressed layers 426,457,104 bytes.
- arm64 manifest: `sha256:444482187203960aa7b762b98d330c037abf6e1b74029333aab2ef60d3e077d5`; compressed layers 425,647,879 bytes.
- Both configurations declare Node 24.21.0 and include the MCP 0.0.82 application and its exact Playwright 1.64.0-alpha-1789764292000 dependencies. The OCI manifest and configuration hashes were independently verified against their returned bytes.
- Upstream package lock: <https://github.com/microsoft/playwright-mcp/blob/v0.0.82/package-lock.json>; original SHA256 `10bcbeb19608f046a76ea3b2c2d3d2bea3b2cc43e852c11f1d1b2ce602e1e5eb`. Retained unmodified as `upstream-package-lock.json`.
- Browser metadata: `browsers.json` extracted from the integrity-checked npm `playwright-core@1.64.0-alpha-1789764292000` tarball, <https://registry.npmjs.org/playwright-core/1.64.0-alpha-1789764292000>. SHA512 integrity `sha512-ZgRaybFv4rRy7QMGnYprEGFdNJnvapNqcaER2w96bDQA+40BWIle1el1Yh9KHD3E6XYmieMB+r+UxFTCauTGGQ==`; original browsers.json SHA256 `6268af2c35843cd3d8be9fc9591125afcc6a2e4a38847ec3d0d4ec6afa023cdd`. Chromium revision 1246, version 154.0.8037.0.

MCP 0.0.83 was available on npm but had no corresponding published official image at resolution time. Pinning the existing 0.0.82 image preserves its exact matched dependencies rather than layering a mismatched browser or downloading packages at runtime. The build adds only metadata, a real-browser readiness probe and a writable output directory. It installs no packages and has no build network.

The recipe embeds canonical JSON representations of the lock and browser metadata so bundling the service does not require shipping loose source assets. Its receipt records the canonical hashes separately from the original publisher hashes above. Cached image verification checks exact package versions, Chromium metadata, executable identity and actual no-network page/screenshot execution. Official image layers, Node and Chromium retain their included licenses/notices; no binaries are copied into the source tree.
