# EnoughFactory private runtime

Every container operation uses `DockerRuntimeEndpoint`: the owned Unix socket,
bundled Docker client and private configuration directory. `dockerInvocation`
removes inherited Docker context, TLS and credential overrides. Mac uses the
private Lima/VZ VM; Linux uses the dedicated rootless daemon.

## Fixed Swift toolchain

`SWIFT_TOOLCHAIN` advertises the supported `swift-6.0.3` recipe. The default
environment remains separate. `prepareToolchain(endpoint, 'swift-6.0.3')` builds
and caches a clean image, verifies Swift and Node in a fresh login shell, then
returns `PreparedToolchain` with its immutable image ID, architecture and versions.
The manager exposes the same operation as `ensureDevelopmentToolchain`.

The recipe uses the official multiarch Swift 6.0.3 Noble image pinned by digest,
checksum-pinned Node 22.22.0 archives, and envmux-compatible tmux/SSH/init plumbing.
The init script derives from pinned envmux's MIT-licensed golden image. The image
contains no source repository, provider authentication or author filesystem.
Plumbing packages are resolved from Ubuntu repositories when first built; receipts
retain the actual resulting image ID rather than claiming byte-identical builds.

Author sessions and captured-source checks use this immutable image. Candidate
receipts preserve the author's toolchain. A coordinator on another architecture
prepares the same fixed recipe locally and records its own checking image. These
are portable Linux Swift checks; native Xcode validation remains separate.

`validatePreparedToolchain` checks retained metadata without runtime access.
`verifyPreparedToolchain` additionally inspects the image and requires the exact
owned image ID, platform and recipe labels; it never builds or launches a container.
Unsupported or missing images fail explicitly. Neither function falls back to the
user's Docker or an arbitrary image supplied by source metadata.

Recipe inputs live in TypeScript and are bundled into the device service. No
additional installed resource path or prebuilt Swift image is required. Preparing
the image needs network access on first use. Runtime tests use a simulated Docker
runner; actual image and Swift-package verification is a separate focused journey.
