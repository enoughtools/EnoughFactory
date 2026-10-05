#!/bin/sh
set -eu
: "${ENOUGHFACTORY_BASE_COMMIT:?base commit is required}"
: "${ENOUGHFACTORY_WORKSPACE_BRANCH:?workspace branch is required}"
case "$ENOUGHFACTORY_BASE_COMMIT" in *[!a-fA-F0-9]*|'') exit 2 ;; esac
git check-ref-format "refs/heads/$ENOUGHFACTORY_WORKSPACE_BRANCH"
export ARTIFACT_FS_ROOT=/var/lib/artifact-fs
mkdir -p "$ARTIFACT_FS_ROOT" /mount/repo
rm -f "$ARTIFACT_FS_ROOT/ready"
if [ ! -d "$ARTIFACT_FS_ROOT/source.git" ]; then
  git clone --mirror /input/source.bundle "$ARTIFACT_FS_ROOT/source.git"
  git --git-dir="$ARTIFACT_FS_ROOT/source.git" update-ref refs/heads/factory-base "$ENOUGHFACTORY_BASE_COMMIT"
  artifact-fs add-repo --name repo --remote "file://$ARTIFACT_FS_ROOT/source.git" \
    --ref refs/heads/factory-base --refresh never --mount-root /mount
fi
artifact-fs daemon --root /mount &
workspace_daemon_pid=$!
workspace_cleanup() {
  trap - EXIT INT TERM
  kill "$workspace_daemon_pid" 2>/dev/null || true
  wait "$workspace_daemon_pid" 2>/dev/null || true
}
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
workspace_wait=0
until mountpoint -q /mount/repo && git -c safe.directory='*' -C /mount/repo rev-parse HEAD >/dev/null 2>&1; do
  kill -0 "$workspace_daemon_pid" 2>/dev/null || { wait "$workspace_daemon_pid"; exit 1; }
  workspace_wait=$((workspace_wait + 1))
  [ "$workspace_wait" -lt 180 ] || { echo 'ArtifactFS mount startup timed out' >&2; exit 1; }
  sleep 1
done
workspace_observed=$(git -c safe.directory='*' -C /mount/repo rev-parse HEAD)
workspace_branch=$(git -c safe.directory='*' -C /mount/repo symbolic-ref --quiet --short HEAD || true)
# Do not register --require-commit: it creates a fixed artifact snapshot and
# deliberately resets HEAD at daemon restart. This is a writable author mount.
# The private bundled source and exact first-mount comparison pin its input;
# later commits and dirty overlays must survive manager recovery.
if [ "$workspace_branch" != "$ENOUGHFACTORY_WORKSPACE_BRANCH" ]; then
  [ "$workspace_observed" = "$ENOUGHFACTORY_BASE_COMMIT" ] || { echo 'Unexpected source revision before workspace initialization' >&2; exit 1; }
  git -c safe.directory='*' -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /mount/repo checkout -b "$ENOUGHFACTORY_WORKSPACE_BRANCH" "$ENOUGHFACTORY_BASE_COMMIT"
fi
# Envmux bootstraps a per-container user. The per-attempt Git state must remain
# writable for that user; no other attempt's files are present in this volume.
chmod -R a+rwX "$ARTIFACT_FS_ROOT"
# The daemon and envmux share Git metadata. The daemon's absolute worktree path
# is mounted as /mount/repo in the agent as well as its configured workdir.
# ArtifactFS's generated fsmonitor hook invokes a binary only in this manager;
# disable it for ordinary Git commands in agent images without that binary.
git -C /mount/repo config core.fsmonitor false
git -C /mount/repo config user.name EnoughFactory
git -C /mount/repo config user.email factory@enoughtools.com
printf '%s\n' "$workspace_observed" > "$ARTIFACT_FS_ROOT/ready"
wait "$workspace_daemon_pid"
