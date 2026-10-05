# Container runtime source and relink kit

This kit builds the native pieces of EnoughFactory's private engine from pinned source. It does not connect to a Docker daemon or alter a user's Docker installation. [sources.json](sources.json) pins Moby; [native-pins.json](native-pins.json) pins runc, libseccomp, Tini, Go and Zig, including download hashes.

The engine builds `dockerd` and `docker-proxy` with cgo disabled. runc retains seccomp support and links libseccomp 2.6.0 against musl supplied by Zig 0.15.2. Tini also uses musl. This replaces upstream static executables whose embedded libc source provenance was not sufficiently established. The Go daemon build omits filesystem project quotas and the optional Btrfs storage driver; the managed runtime uses its configured compatible storage driver.

## Rebuild

The Go engine script needs Node 22 and Go 1.26.8. Its exact Moby archive contains the vendored dependencies:

```sh
node runtime/container/relink-kit/build-go-engine.mjs \
  --architecture all --jobs 4 \
  --cache /path/to/verified-source-cache \
  --output /path/to/container-build
```

The native script needs Python 3.10 or newer, a POSIX shell/Bash, `make`, `gperf`, `file`, binutils (`nm`, `ld`, `strip`) and ordinary coreutils/`grep`/`sed`/`awk`/`tar`/`gzip`. Xcode Command Line Tools supply the Mac build utilities. The pinned release contains its generated configure/libtool files; Python bindings are disabled, so autoconf, automake, Cython and CMake are not required. It downloads and verifies the pinned Go and Zig toolchains for Mac or Linux, then cross-compiles Linux ARM64 and x64:

```sh
python3 runtime/container/relink-kit/build-native.py \
  --jobs 4 \
  --work /path/to/retained-build-work \
  --cache /path/to/verified-source-cache \
  --output /path/to/container-build
```

Use `--architecture arm64` or `--architecture x64` for the Go script and `--arch arm64` or `--arch x64` for the native script to build one target. Keep separate output/work directories when comparing original and modified builds. Each script records its input hashes, commands, build metadata and output hashes; native output also retains the external-link objects and libseccomp archive.

To rebuild against a modified library, pass `--libseccomp-source /path/to/modified-libseccomp` to `build-native.py`. Supply a complete libseccomp source tree, including its generated configure files. The script rebuilds that library and runc together. EnoughFactory permits modification and reverse engineering for debugging those modifications. The library's [LGPL 2.1 terms](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) remain applicable to it.

You can also relink retained runc application objects with a replacement `libseccomp.a`, without recompiling Go. After extracting the source companion, use a library built for the same architecture:

```sh
python3 EnoughFactory-container-source/relink-kit/relink-runc.py \
  --kit EnoughFactory-container-source/relink/x64 \
  --libseccomp /path/to/rebuilt-libseccomp.a \
  --output /path/to/runc-modified \
  --zig /path/to/zig-0.15.2/zig
```

Use `relink/arm64` for ARM64. The helper remaps the original link command to the extracted kit and checks that its objects exist. Changes to library headers or inlined code require the full rebuild above. Release verification has exercised a relocated x64 object kit; the ARM64 engine journey also checks init and seccomp behavior with the rebuilt binaries. The corresponding proof receipts belong in the source companion.

Stop the private runtime before substituting runtime binaries. Build a desktop distribution from the repository's packaging scripts when changing signed or sealed application resources. Changes to kernel/runtime behavior need a real container and factory journey on the target OS; matching a compile target alone is insufficient.

## Source distribution

Published native releases provide the builder's source archive using a platform/architecture-qualified name such as `EnoughFactory-0.1.0-darwin-arm64-container-sources.tar.gz`. This preserves separate host build provenance for Mac ARM64, Linux x64 and Linux ARM64. The companion contains exact source archives, these build scripts and pins, retained architecture-specific relink objects, build provenance and covered third-party source. Preserve the companion and full notices when redistributing the corresponding executables. The bundled Ubuntu guest has its own package-source companion; it is separate from this engine kit. Normal `pnpm runtime:prepare` builds the target's components and embeds its exact source companion under `runtime/container/sources` in prepared desktop resources.

Once both build manifests and their retained files exist, generate the source archive without changing the runtime:

```sh
node runtime/container/relink-kit/create-source-artifact.mjs \
  --build-output /path/to/container-build \
  --output /path/to/EnoughFactory-container-sources.tar.gz
```

The archive's companion JSON records source and executable hashes. The builder verifies its pinned source bytes and actual binary hashes before copying their sources and relink objects. Packaging copies those same bytes under the release's qualified filename and retains the matching receipt.

Release assembly is recorded in [release-progress.md](../../../docs/release-progress.md). A checked-in build script or a planned archive name is not a claim that a source companion has already been built or published.
