#!/usr/bin/env sh
# Build the default envmux image and tag it as the reference generated
# configurations point at.
#
# `envmux config generate` writes
#
#     [image]
#     reference = "ghcr.io/strigops-io/envmux-default:0.1.0"
#
# and the daemon pulls a reference only when no image with that tag exists
# locally. Until that tag is published, a fresh project in a sibling directory
# fails at `envmux up` with a registry error.
#
# Building images/default.Dockerfile under exactly that tag makes the pull
# unnecessary: every adjacent project using the generated default finds the
# image already on this machine, with plain `docker build` and no registry,
# credentials, or buildx involved.
#
# The tag is read out of the starter template so the two cannot drift; override
# it with $ENVMUX_DEFAULT_IMAGE or the first argument.
#
#   ./scripts/build-default-image.sh
#   ./scripts/build-default-image.sh --force
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
dockerfile="$root/images/default.Dockerfile"
fallback='ghcr.io/strigops-io/envmux-default:0.1.0'
force=0
reference="${ENVMUX_DEFAULT_IMAGE:-}"

for arg in "$@"; do
    case "$arg" in
        -f|--force) force=1 ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*)
            echo "unknown option: $arg" >&2
            exit 2
            ;;
        *) reference="$arg" ;;
    esac
done

if [ -z "$reference" ]; then
    # The one place the default is written down for users.
    generate="$root/crates/envmux-config/src/generate.rs"
    if [ -f "$generate" ]; then
        reference="$(sed -n 's/.*reference = "\([^"]*envmux-default:[^"]*\)".*/\1/p' "$generate" | head -n 1)"
    fi
fi
[ -n "$reference" ] || reference="$fallback"

[ -f "$dockerfile" ] || { echo "missing $dockerfile" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || {
    echo "docker not found. Install Docker and try again." >&2
    exit 1
}
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || {
    echo "the Docker engine is not reachable. Start it and try again." >&2
    exit 1
}

if [ "$force" -eq 0 ] && docker image inspect "$reference" >/dev/null 2>&1; then
    echo "image $reference already present (--force rebuilds)"
    exit 0
fi

echo "==> Building $reference"
echo "    first build pulls a Debian/Node base and several toolchains; expect minutes"
docker build --tag "$reference" --file "$dockerfile" "$root"

echo
echo "$reference is ready locally."
echo "Projects whose .envmux.toml declares it will use this image without a pull."
