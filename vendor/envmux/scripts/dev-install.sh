#!/usr/bin/env sh
# Install this working tree as the `devenvmux` global command.
#
# Packs src/Envmux as a .NET global tool and installs it from a local folder, so
# you can exercise envmux from anywhere without a release, and without a
# half-built binary shadowing a real `envmux` on your PATH. The command is
# deliberately named differently for that reason.
#
# Re-run it after any change; it replaces whatever was installed before.
#
#   ./scripts/dev-install.sh                 install (Release)
#   ./scripts/dev-install.sh --debug         install with a usable stack trace
#   ./scripts/dev-install.sh --uninstall     remove it
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="$ROOT/src/Envmux/Envmux.csproj"
OUTPUT="$ROOT/artifacts/tool"
TOOL="devenvmux"
CONFIGURATION="Release"

for arg in "$@"; do
    case "$arg" in
        --uninstall)
            dotnet tool uninstall --global "$TOOL" >/dev/null 2>&1 || true
            rm -rf "$OUTPUT"
            printf 'removed %s\n' "$TOOL"
            exit 0
            ;;
        --debug) CONFIGURATION="Debug" ;;
        -h|--help)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            printf 'unknown option: %s\n' "$arg" >&2
            exit 2
            ;;
    esac
done

command -v dotnet >/dev/null 2>&1 || {
    printf 'dotnet is not on PATH. Install the .NET 10 SDK.\n' >&2
    exit 1
}

printf 'packing %s...\n' "$CONFIGURATION"
rm -rf "$OUTPUT"
dotnet pack "$PROJECT" -c "$CONFIGURATION" -o "$OUTPUT" --nologo

# An install over an existing tool fails rather than replacing it, so the
# uninstall is unconditional and its failure is the expected case.
dotnet tool uninstall --global "$TOOL" >/dev/null 2>&1 || true

printf 'installing %s...\n' "$TOOL"
dotnet tool install --global --add-source "$OUTPUT" --prerelease "$TOOL"

cat <<EOF

$TOOL installed from $CONFIGURATION

  devenvmux --dry-run          what a session here would be
  devenvmux my-task            start one
  devenvmux prune --dry-run    what is left lying around

EOF

# A fresh tools directory is not on PATH until the shell is restarted, and the
# symptom is "command not found" straight after a successful install.
case ":$PATH:" in
    *":$HOME/.dotnet/tools:"*) ;;
    *) printf 'Add %s/.dotnet/tools to PATH, or open a new terminal.\n' "$HOME" ;;
esac
