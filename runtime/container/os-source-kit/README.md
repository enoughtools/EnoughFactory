# Bundled Ubuntu guest source companion

EnoughFactory's Mac bundles contain the unmodified Canonical Ubuntu 24.04 server
cloud image, release `20260926`. The image URLs and SHA-256 values are pinned in
`../pins.json`. Both image architectures are covered by this kit. Their installed
binary package manifests are kept here; source resolution never substitutes the
latest package version.

The companion delivers the complete Ubuntu source package for every installed
package and every exact `Built-Using` / `Static-Built-Using` source identity,
rather than attempting to exclude packages based on license guesses.
Each source package includes its `.dsc`, original upstream archive(s), and every
Ubuntu/Debian packaging or patch archive named by the descriptor. These include
the packaging's build and installation controls, patches and license notices.
The source is in its original preferred form, not a generated code listing.

This kit covers the distributed base images. Software users subsequently install
inside their private guest is a separate local modification. EnoughFactory's
own guest provisioning and container-runtime source are in the product source
release, alongside this kit.

## Obtain and verify the release source

Download `Ubuntu-source-companion.json`, `Ubuntu-sources.lock.json`,
`Ubuntu-source-companion-SHA256SUMS`, `Ubuntu-source-companion-README.md`,
`Ubuntu-archive-evidence.tar.gz`, and **every**
`EnoughFactory-Ubuntu-24.04-20260926-sources-partNN.tar.gz` from the **same public
GitHub release** that supplies the EnoughFactory installer. These are companion
release assets with the same download access as the executable, not an offer to
provide source later or a collection of links to third-party source hosts.

Verify all source archive bytes and every `.dsc`/source member against the release
lock and index:

```sh
python3 runtime/container/os-source-kit/prepare-source-companion.py verify \
  --output /path/to/downloaded-companion
```

Extract each source part into the same directory. Packages are under
`sources/PACKAGE/`. To unpack a package and its Ubuntu patches on a development
Ubuntu system:

```sh
dpkg-source -x sources/PACKAGE/PACKAGE_VERSION.dsc
```

The resulting `debian/control`, `debian/rules`, `debian/patches`, changelog and
upstream build files specify that package's build dependencies and build process.
Use an isolated Ubuntu build environment with the locked snapshot enabled for
both `deb` and `deb-src`, install the package's build dependencies with
`apt-get build-dep`, then run `dpkg-buildpackage -us -uc` in the unpacked source.
Install rebuilt packages inside a disposable guest with `dpkg -i`. Some packages
have additional documented build dependencies or architecture requirements;
their source package is the authority. These instructions do not claim bitwise
reproduction of Canonical's entire cloud image or access to Canonical's signing
keys. A modified guest can be booted by EnoughFactory's private runtime without
requiring those keys.

## Generate companion assets for a release

Prerequisites: Python 3 and `gpgv`; sufficient storage for the source cache and
release archives. The commands use private cache paths and do not alter host apt
configuration, Docker, GPG keyrings or the bundled guest images.

```sh
python3 runtime/container/os-source-kit/prepare-source-companion.py resolve
python3 runtime/container/os-source-kit/prepare-source-companion.py download
python3 runtime/container/os-source-kit/prepare-source-companion.py archive
python3 runtime/container/os-source-kit/prepare-source-companion.py verify
```

`resolve` authenticates the Ubuntu snapshot's `InRelease` signatures against the
official, SHA-256-pinned Ubuntu archive keyring and allowed signing fingerprints.
It verifies every compressed binary/source index against `InRelease`, matches
the exact binary name, version and architecture, reads the indexed `Source`
identity, and locks every `.dsc` and source archive's URL, size and SHA-256. The
main snapshot is `20260926T235959Z`. Older embedded source versions are resolved
using Launchpad publication dates and independently authenticated historical
snapshot indexes; those signed records are retained too.
Hash-verified source bytes are retained locally and
then copied into the companion release archives. The signed archive metadata is
also distributed for independent provenance verification.

`download` verifies the full source set and cross-checks every descriptor's
dependencies. `archive` splits the source set into GitHub-compatible assets,
records hashes and package ownership, and includes this kit in each part.
`verify` reads the actual release archives and checks every required member;
missing, duplicate or modified source files fail verification. Upload all
generated assets before publishing a binary release; preserve them for as long
as the matching executables remain available. A source lock without the actual
source archives does not complete release delivery.

`extract-image-notices.sh IMAGE ARCH SHA256 OUTPUT [NBD_DEVICE]` provides a
read-only Linux extraction method for the exact original images. Run it as root
inside a dedicated EnoughFactory-owned guest with qemu-utils installed. It
preserves raw dpkg status, binary-to-source identities, all package copyright
texts, complete `/usr/share/common-licenses`, cloud build metadata and the image
hash before and after extraction. The full notice archives belong in the
installer's third-party material as well as the public release. The extraction
evidence shows neither pinned image contains a preinstalled snap payload.

## Provenance references

- [Pinned Canonical image release](https://cloud-images.ubuntu.com/releases/noble/release-20260926/)
- [Ubuntu snapshot service](https://snapshot.ubuntu.com/)
- [Ubuntu archive integrity verification](https://documentation.ubuntu.com/security/software-integrity/archive-verification/)
- [Debian source package format and descriptors](https://manpages.ubuntu.com/manpages/noble/en/man5/deb-src-control.5.html)
- [Ubuntu source package workflow](https://canonical-ubuntu-packaging-guide.readthedocs-hosted.com/en/latest/how-to/download-source-packages/)
