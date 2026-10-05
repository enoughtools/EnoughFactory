#!/usr/bin/env sh
# Build the current tree and run it.
#
# Two builds, deliberately: the in-container agent first (a static musl
# binary the daemon copies into workspaces — without it the credential shim
# silently does not exist), then the envmux binary itself. Then hand over to
# the fresh build with whatever arguments you gave — none means a session in
# the directory you invoked this from.
#
#   ./run-dev.sh              # session here, current code
#   ./run-dev.sh manage       # management view
#   ./run-dev.sh daemon --state-dir /tmp/x --grace-secs 30   # foreground daemon
set -eu

root="$(cd "$(dirname "$0")" && pwd)"

if rustup target list --installed 2>/dev/null | grep -q '^x86_64-unknown-linux-musl$'; then
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
        cargo build --manifest-path "$root/Cargo.toml" \
        -p envmux-agent --release --target x86_64-unknown-linux-musl
else
    echo "note: x86_64-unknown-linux-musl not installed; the credential shim will be absent." >&2
    echo "      fix: rustup target add x86_64-unknown-linux-musl" >&2
fi

cargo build --manifest-path "$root/Cargo.toml" -p envmux-cli

# Front-load the image build where you can watch it: same tag the daemon
# expects, docker CLI progress on this terminal, skipped when already built.
# Without this, a first session builds it invisibly behind "preparing
# namespace…". Skipped when the current directory has no config yet —
# onboarding inside the session handles that case.
if [ -f .envmux.toml ]; then
    "$root/target/debug/envmux" image build
fi

exec "$root/target/debug/envmux" "$@"
