#!/usr/bin/env sh
# Build and install the self-contained `envmux` binary a release ships.
#
# The other half of scripts/dev-install.sh. That one packs this tree as a .NET
# global tool called `devenvmux`, which is right for iterating and wrong for the
# last check before a release: a global tool runs on the SDK that is already on
# the machine, under a command name nothing in the documentation mentions.
#
# This publishes exactly what the canary job publishes — self-contained, single
# file, compressed, stamped with the UTC minute — for this machine's platform,
# and drops it in ~/.envmux/bin as `envmux`. So what you test is the artifact
# somebody downloads, under the name every page tells them to type, with no .NET
# install standing behind it.
#
# It lives beside the rest of envmux's state on purpose. Uninstalling envmux is
# deleting ~/.envmux, and a binary somewhere else would survive that and keep
# answering.
#
#   ./scripts/release-install.sh                 build and install for this machine
#   ./scripts/release-install.sh --archive       also write the tarball and SHA256SUMS
#   ./scripts/release-install.sh --rid osx-arm64 build for another platform
#   ./scripts/release-install.sh --version 1.2.3 stamp it with something else
#   ./scripts/release-install.sh --uninstall     remove it
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="$ROOT/src/Envmux/Envmux.csproj"
STAGE="$ROOT/artifacts/stage"
DIST="$ROOT/artifacts/dist"

PREFIX="${ENVMUX_HOME:-$HOME/.envmux}"
BIN="$PREFIX/bin"
INSTALLED="$BIN/envmux"

RID=""
VERSION=""
ARCHIVE=0
UNINSTALL=0

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) UNINSTALL=1 ;;
        --archive) ARCHIVE=1 ;;
        --rid) shift; [ $# -gt 0 ] || { printf -- '--rid needs a runtime identifier\n' >&2; exit 2; }; RID="$1" ;;
        --version) shift; [ $# -gt 0 ] || { printf -- '--version needs a value\n' >&2; exit 2; }; VERSION="$1" ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

if [ "$UNINSTALL" -eq 1 ]; then
    rm -f "$INSTALLED"
    # The directory only, never the one above it: that holds host.json, the
    # certificates and the VM's disks, and this script did not put them there.
    rmdir "$BIN" 2>/dev/null || true
    printf 'removed %s\n' "$INSTALLED"
    printf 'PATH is yours to edit; nothing here changed it.\n'
    exit 0
fi

command -v dotnet >/dev/null 2>&1 || {
    printf 'dotnet is not on PATH. Install the .NET 10 SDK.\n' >&2
    exit 1
}

# This machine, spelled the way `dotnet publish --runtime` spells it.
if [ -z "$RID" ]; then
    case "$(uname -s)" in
        Darwin) os="osx" ;;
        Linux) os="linux" ;;
        *) printf 'unrecognised platform: %s. Pass --rid.\n' "$(uname -s)" >&2; exit 1 ;;
    esac

    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64) arch="x64" ;;
        *) printf 'unrecognised architecture: %s. Pass --rid.\n' "$(uname -m)" >&2; exit 1 ;;
    esac

    RID="$os-$arch"
fi

# The same format the canary stamps, so a binary can always be matched back to
# when it was built — and so `envmux --version` says something more useful than
# the placeholder in the csproj.
[ -n "$VERSION" ] || VERSION="$(date -u +'%Y.%m.%d.%H%M')"

# A release always has the portal page in it, because the release job always has
# Node. Without one here the binary still builds, still runs and still routes —
# and its portal answers "built without Node", which is exactly the thing a
# release must never be. Said before the five minutes rather than after.
command -v node >/dev/null 2>&1 || cat <<'EOF'
no Node on PATH — the portal page will not be in this binary.
A real release always has one. Install Node and run this again to match it.

EOF

printf 'publishing %s...\n' "$RID"

OUTPUT="$STAGE/$RID"
rm -rf "$OUTPUT"

# Every flag here is the canary job's, and they are here to be identical rather
# than merely similar: --self-contained so it needs no runtime, single file and
# compression from the csproj and the flag below, and DebugType=none so what
# ships is one file and not a file with a .pdb beside it.
dotnet publish "$PROJECT" \
    --configuration Release \
    --runtime "$RID" \
    --self-contained true \
    -p:Version="$VERSION" \
    -p:InformationalVersion="$VERSION" \
    -p:EnableCompressionInSingleFile=true \
    -p:DebugType=none \
    --output "$OUTPUT" \
    --nologo

case "$RID" in
    win-*) PUBLISHED="$OUTPUT/envmux.exe" ;;
    *) PUBLISHED="$OUTPUT/envmux" ;;
esac

[ -f "$PUBLISHED" ] || {
    printf 'publish produced no binary in %s\n' "$OUTPUT" >&2
    exit 1
}

mkdir -p "$BIN"

# Removed and copied rather than copied over: a running copy keeps its inode, so
# replacing the name leaves whatever is running alone instead of failing.
rm -f "$INSTALLED"
cp "$PUBLISHED" "$INSTALLED"
chmod +x "$INSTALLED"

PACKAGE=""

if [ "$ARCHIVE" -eq 1 ]; then
    mkdir -p "$DIST"

    # Named for the platform and the stamp, the way the release names them, so a
    # directory of these is readable a week later.
    case "$RID" in
        win-*) PACKAGE="$DIST/envmux-$VERSION-$RID.zip" ;;
        *) PACKAGE="$DIST/envmux-$VERSION-$RID.tar.gz" ;;
    esac

    rm -f "$PACKAGE"

    case "$RID" in
        win-*) (cd "$OUTPUT" && zip -qr "$PACKAGE" .) ;;
        *) tar -czf "$PACKAGE" -C "$OUTPUT" . ;;
    esac

    # Over every archive in the directory, so a sums file lists what is actually
    # there rather than only the one just built. Named rather than globbed
    # inside the redirect, so it cannot end up listing itself half-written.
    (cd "$DIST" && sha256sum envmux-* > SHA256SUMS.txt.new && mv SHA256SUMS.txt.new SHA256SUMS.txt)
fi

# The length, not the blocks. `du` reports what has been allocated, and on a
# copy-on-write filesystem a file copied a moment ago has almost none of that
# yet — it reported a 50 MB binary as 512 bytes, which reads as a failed build.
BYTES="$(wc -c < "$INSTALLED")"
SIZE="$(awk -v b="$BYTES" 'BEGIN { printf "%.1f MB", b / 1048576 }')"

cat <<EOF

envmux $VERSION ($RID, $SIZE)
  → $INSTALLED
EOF

[ -z "$PACKAGE" ] || printf '  → %s\n' "$PACKAGE"
printf '\n'

case ":$PATH:" in
    *":$BIN:"*)
        printf '  Already on PATH. `envmux --version` should answer with the stamp above.\n'
        ;;
    *)
        # Not written for you. A shell's rc file is that shell's business, and
        # which of the four candidates on this machine is the real one is not
        # something a build script gets to decide.
        printf '  Not on PATH. Add it to your shell:\n\n'
        printf '    export PATH="%s:$PATH"\n' "$BIN"
        ;;
esac

cat <<EOF

  This is the real command name, so it shadows — and is shadowed by — any other
  envmux on PATH. \`$0 --uninstall\` takes it back off.
EOF
