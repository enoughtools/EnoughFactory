#!/usr/bin/env bash
# End-to-end smoke workflow: fixture repo → up → create → ls → capture →
# snapshots → reap. Requires Docker and the debug binaries.
set -euo pipefail
# Git Bash on Windows rewrites /container/paths into C:/... host paths;
# every path we pass is container-side or already Windows-style.
export MSYS2_ARG_CONV_EXCL='/work/*;/cache/*;/seed/*'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug"
EXE=""
if [[ -x "$BIN/envmux.exe" && ! -x "$BIN/envmux" ]]; then EXE=".exe"; fi
CLI="$BIN/envmux$EXE"
# One binary is the CLI and the daemon; there has been no separate
# `envmux-daemon` executable for a while. Starting a path that does not exist
# only failed the background job, so the script carried on against whichever
# daemon `envmux up` happened to start — and step 7, which exists to prove a
# restart rehydrates state, was restarting nothing.
daemon() { "$CLI" daemon; }
WORK="${SMOKE_DIR:-$(mktemp -d)}"
export ENVMUX_STATE_DIR="$WORK/state"
mkdir -p "$ENVMUX_STATE_DIR"

echo "== smoke dir: $WORK"

# 1. A tiny image satisfying the substrate requirement (tmux + git).
docker build -t envmux-smoke:latest -f - "$WORK" <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache git tmux findutils coreutils
EOF

# 2. Fixture repo with a committed .envmux.toml.
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -b main -q
git -C "$FIXTURE" config user.email smoke@envmux.test
git -C "$FIXTURE" config user.name smoke
cat > "$FIXTURE/.envmux.toml" <<'EOF'
[meta]
schema = 1
namespace = "smoke"

[image]
reference = "envmux-smoke:latest"

[workspace]
workdir = "/work"

[tasks.hello]
command = "echo hello from envmux > /work/hello.txt"

[services.cache]
kind = "redis"
version = "7-alpine"
provision_timeout = "60s"

[lease]
initial = "1d"

[volumes.named.seed]
class = "cache"
path = "/cache"
mode = "copy-on-start"
EOF
echo "smoke fixture" > "$FIXTURE/README.md"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -q -m "fixture"

# 3. Daemon up + namespace registration.
daemon &
DAEMON_PID=$!
cleanup() {
  kill "$DAEMON_PID" 2>/dev/null || true
  docker ps -aq --filter label=dev.envmux.namespace=smoke | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter label=dev.envmux.namespace=smoke | xargs -r docker volume rm -f >/dev/null
  docker network ls -q --filter label=dev.envmux.namespace=smoke | xargs -r docker network rm >/dev/null
}
trap cleanup EXIT
sleep 2

cd "$FIXTURE"
"$CLI" up
MSYS_NO_PATHCONV=1 docker run --rm -v envmux-smoke-seed:/seed alpine:3.20 sh -c 'echo copied > /seed/marker'

# 4. Create two concurrent workspaces on one branch; wait for ready.
"$CLI" create --name smoke-a --branch main --wait
"$CLI" create --name smoke-b --branch main --wait

# 5. The task ran; the listing sees both.
MSYS2_ARG_CONV_EXCL='*' "$CLI" run smoke-a -- cat /work/hello.txt | grep -q "hello from envmux"
MSYS2_ARG_CONV_EXCL='*' "$CLI" run smoke-a -- cat /cache/marker | grep -q copied
MSYS2_ARG_CONV_EXCL='*' "$CLI" run smoke-a -- sh -c 'test -s /run/envmux/secrets/cache/REDIS_URL'
"$CLI" ls --porcelain | grep -c '^smoke-' | grep -q '^2$'

# 6. Capture and snapshot listing.
"$CLI" capture smoke-a
"$CLI" snapshots smoke-a | grep -q clean
SNAP_ID=$("$CLI" snapshots smoke-a --porcelain | head -n1 | cut -f1)
"$CLI" snapshots --from "$SNAP_ID"

# 7. Gracefully stop and restart: persisted namespaces must rehydrate before workers/API.
"$CLI" down
wait "$DAEMON_PID"
daemon &
DAEMON_PID=$!
sleep 2
"$CLI" ls --porcelain | grep -q '^smoke-a'

# 8. Reap one; the other survives.
WS_ID=$("$CLI" ls --porcelain | awk -F'\t' '$1 == "smoke-a" {print $12}')
"$CLI" lease smoke-a --until "$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"
"$CLI" reap
"$CLI" ls --porcelain | grep -q '^smoke-b'
if "$CLI" ls --porcelain | grep -q '^smoke-a.*ready'; then
  echo "smoke-a should have been reaped"; exit 1
fi

echo "== smoke passed (workspace id: $WS_ID)"
