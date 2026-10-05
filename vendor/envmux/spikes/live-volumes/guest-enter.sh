#!/bin/sh
# Run one task with live volumes of its own. Started as root inside a session's
# instance; the task itself runs as the session user.
#
#   envmux-live-enter <user> <task> <url> <namespace> <mountpoint> <local-dirs> -- <command...>
#
#   <local-dirs>  comma-separated, may be empty
#   the task's key is read from stdin, never from the command line
#
# Two things have to be true for a per-task key to mean anything, and only one
# of them is the key:
#
#   1. The key is scoped, so the workstation refuses what this task was not
#      granted. That is Grants.cs, on the other end.
#   2. The mount made with it is visible to this task and to nothing else. A
#      scoped key with a shared mountpoint authorises nothing at all: by the
#      time a sibling task reads the file, the kernel is already holding it open
#      on this task's behalf and no request reaches the workstation to refuse.
#
# (2) is this script: unshare(CLONE_NEWNS) gives the task a mount namespace of
# its own, and every mount below happens inside it. A sibling task looking at
# the same path sees the empty directory that was there before.
#
# The whole tree is mounted once at /run/envmux/live and the tool's namespace is
# bound from there onto its home path. One rclone per task rather than one per
# namespace, and it is what puts git credentials in reach: they are the virtual
# files under /run/envmux/live/git/, and git-credential-envmux below reads them.
#
# The script re-executes itself as `--inside` rather than passing the second
# half to `sh -c`. A script full of apostrophes inside a quoted -c inside an
# exec is three levels of escaping, and the first version of this lost one and
# failed at a line number in a file that does not exist on disk.
set -eu

live=/run/envmux/live

if [ "${1:-}" != "--inside" ]; then
    user=$1
    task=$2
    url=$3
    namespace=$4
    mountpoint=$5
    locals=$6
    shift 6
    [ "${1:-}" = "--" ] && shift

    # On stdin, so it is in no process's argv — /proc/<pid>/cmdline is world
    # readable inside the container and every task runs as the same account.
    read -r key

    ENVMUX_LIVE_KEY=$key
    ENVMUX_LIVE_URL=$url
    ENVMUX_LIVE_TASK=$task
    ENVMUX_LIVE_USER=$user
    ENVMUX_LIVE_UID=$(id -u "$user")
    ENVMUX_LIVE_GID=$(id -g "$user")
    ENVMUX_LIVE_NS=$namespace
    ENVMUX_LIVE_MOUNT=$mountpoint
    ENVMUX_LIVE_LOCALS=$locals
    ENVMUX_LIVE_LOCAL_ROOT=/var/lib/envmux/live/$task/$namespace

    export ENVMUX_LIVE_KEY ENVMUX_LIVE_URL ENVMUX_LIVE_TASK ENVMUX_LIVE_USER \
           ENVMUX_LIVE_UID ENVMUX_LIVE_GID ENVMUX_LIVE_NS ENVMUX_LIVE_MOUNT \
           ENVMUX_LIVE_LOCALS ENVMUX_LIVE_LOCAL_ROOT

    mkdir -p "$live" "$mountpoint" "$ENVMUX_LIVE_LOCAL_ROOT"
    chown "$user" "$mountpoint"

    # fuse3 will not honour --allow-other unless its own config permits it, and
    # without --allow-other the mount root makes is invisible to the account the
    # task runs as.
    grep -qx user_allow_other /etc/fuse.conf 2>/dev/null || echo user_allow_other >> /etc/fuse.conf

    # The credential helper, and git told to use it. `get` only: store and erase
    # are answered with silence, because a container does not get to change what
    # the workstation is signed in as. The helper reads a file, and the file is
    # behind this task's own mount — so the helper needs no key of its own, and
    # nothing a sibling task can read would let it ask for the credential.
    cat > /usr/local/bin/git-credential-envmux <<'HELPER'
#!/bin/sh
[ "${1:-}" = "get" ] || exit 0
host=""; protocol=""
while IFS== read -r k v; do
    case $k in
        host) host=$v ;;
        protocol) protocol=$v ;;
        "") break ;;
    esac
done
[ "$protocol" = "https" ] && [ -n "$host" ] || exit 0
case $host in */*|.*|"") exit 0 ;; esac
cat "/run/envmux/live/git/$host" 2>/dev/null
HELPER
    chmod 0755 /usr/local/bin/git-credential-envmux
    git config --system credential.helper envmux 2>/dev/null || true

    exec unshare --mount --propagation private -- "$0" --inside "$@"
fi

shift

# ---------------------------------------------------------------------------
# Inside the task's own mount namespace.

# Nothing mounted from here propagates back to the instance's own namespace.
mount --make-rprivate / 2>/dev/null || true

# rclone reads its key from a config file, so the config file is the thing to
# hide: a tmpfs of its own, mounted inside this namespace, root-owned at 0600.
# rclone runs as root and can read it; the task runs as the session user in the
# same namespace and cannot; a sibling task is in another namespace and cannot
# see that it exists.
mkdir -p /root/.config/rclone
mount -t tmpfs -o mode=0700,nosuid,nodev,noexec tmpfs /root/.config/rclone

umask 077
printf '[envmux]\ntype = webdav\nurl = %s\nvendor = other\nbearer_token = %s\n' \
    "$ENVMUX_LIVE_URL" "$ENVMUX_LIVE_KEY" > /root/.config/rclone/rclone.conf

# Off this shell's environment as soon as it is on the tmpfs: the task is about
# to inherit whatever is left of it.
unset ENVMUX_LIVE_KEY

rclone mount "envmux:" "$live" \
    --allow-other \
    --uid "$ENVMUX_LIVE_UID" --gid "$ENVMUX_LIVE_GID" \
    --dir-perms 0700 --file-perms 0600 \
    --dir-cache-time 5s \
    --attr-timeout 1s \
    --vfs-cache-mode writes \
    --vfs-write-back 1s \
    --no-checksum \
    --log-file "/var/log/envmux-live-$ENVMUX_LIVE_TASK.log" --log-level INFO &
rclone_pid=$!

ready=""
for _ in $(seq 40); do
    if mountpoint -q "$live"; then ready=yes; break; fi
    sleep 0.25
done

if [ -z "$ready" ]; then
    echo "envmux live: $live did not mount for task $ENVMUX_LIVE_TASK" >&2
    kill "$rclone_pid" 2>/dev/null || true
    exit 1
fi

# The tool's namespace, where the tool looks for it. A bind of a subtree of the
# FUSE mount, so ~/.claude and /run/envmux/live/claude are the same directory.
if [ -d "$live/$ENVMUX_LIVE_NS" ]; then
    mount --bind "$live/$ENVMUX_LIVE_NS" "$ENVMUX_LIVE_MOUNT"
fi

# Per task, not per session: two tasks that both keep history keep their own,
# because they are two mount namespaces over two directories.
IFS=,
for name in $ENVMUX_LIVE_LOCALS; do
    [ -n "$name" ] || continue

    # A local directory outside this task's scope has no placeholder to bind
    # over, because the workstation did not offer one. The scope is the
    # authority: skip it rather than fail the task, so one list of local
    # directories can be handed to every task whatever each was granted.
    [ -d "$ENVMUX_LIVE_MOUNT/$name" ] || continue

    mkdir -p "$ENVMUX_LIVE_LOCAL_ROOT/$name"
    chown "$ENVMUX_LIVE_USER" "$ENVMUX_LIVE_LOCAL_ROOT/$name"
    mount --bind "$ENVMUX_LIVE_LOCAL_ROOT/$name" "$ENVMUX_LIVE_MOUNT/$name"
done
unset IFS

# Not exec: something has to outlive the task to take the mount down. The
# namespace dies with this shell, but rclone would hold it open.
if setpriv --reuid="$ENVMUX_LIVE_UID" --regid="$ENVMUX_LIVE_GID" --init-groups -- "$@"; then
    status=0
else
    status=$?
fi

# Binds come off first, innermost first: a FUSE mount with anything mounted on
# top of it is busy, and fusermount3 -u fails with EBUSY without saying what is
# holding it. That failure left rclone running and this shell waiting on it
# forever, which from outside read as a task that never finished.
IFS=,
for name in $ENVMUX_LIVE_LOCALS; do
    [ -n "$name" ] || continue
    umount "$ENVMUX_LIVE_MOUNT/$name" 2>/dev/null || true
done
unset IFS
umount "$ENVMUX_LIVE_MOUNT" 2>/dev/null || true

fusermount3 -u "$live" 2>/dev/null || umount -l "$live" 2>/dev/null || true

kill "$rclone_pid" 2>/dev/null || true
for _ in $(seq 20); do
    kill -0 "$rclone_pid" 2>/dev/null || break
    sleep 0.25
done

exit $status
