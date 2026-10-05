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

The native script needs Python 3.10 or newer, a POSIX shell, `make`, `tar` and `file`. It downloads and verifies the pinned Go and Zig toolchains for Mac or Linux, then cross-compiles Linux ARM64 and x64:

```sh
python3 runtime/container/relink-kit/build-native.py \
  --jobs 4 \
  --work /path/to/retained-build-work \
  --cache /path/to/verified-source-cache \
  --output /path/to/container-build
```

Use `--architecture arm64` or `--architecture x64` for the Go script and `--arch arm64` or `--arch x64` for the native script to build one target. Keep separate output/work directories when comparing original and modified builds. Each script records its input hashes, commands, build metadata and output hashes; native output also retains the external-link objects and libseccomp archive.

To rebuild against a modified library, pass `--libseccomp-source /path/to/modified-libseccomp` to `build-native.py`. Supply a complete libseccomp source tree, including its generated configure files. The script rebuilds that library and runc together. EnoughFactory permits modification and reverse engineering for debugging those modifications. The library's [LGPL 2.1 terms](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) remain applicable to it.

Stop the private runtime before substituting runtime binaries. Build a desktop distribution from the repository's packaging scripts when changing signed or sealed application resources. Changes to kernel/runtime behavior need a real container and factory journey on the target OS; matching a compile target alone is insufficient.

## Source distribution

Published native releases must provide `EnoughFactory-<version>-container-sources.tar.gz` beside their application downloads. The companion contains exact source archives, these build scripts and pins, retained architecture-specific relink objects, build provenance and covered third-party source. Preserve the companion and full notices when redistributing the corresponding executables. The bundled Ubuntu guest has its own package-source companion; it is separate from this engine kit.

Release assembly is recorded in [release-progress.md](../../../docs/release-progress.md). A checked-in build script or a planned archive name is not a claim that a source companion has already been built or published.
