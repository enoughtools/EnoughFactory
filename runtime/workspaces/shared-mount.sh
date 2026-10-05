#!/bin/sh
set -eu
# Executed only by the trusted service in the Docker host's mount namespace.
# A named Docker volume is rprivate and cannot share a FUSE submount.
workspace_attempt_id=${1:?attempt ID is required}
workspace_mount_action=${2:-prepare}
case "$workspace_attempt_id" in
  ''|*[!a-zA-Z0-9_-]*) echo 'Invalid attempt ID' >&2; exit 2 ;;
esac
[ "${#workspace_attempt_id}" -le 80 ] || exit 2
case "$workspace_mount_action" in prepare|remove) ;; *) exit 2 ;; esac
# Execute standard tools after entering the host namespace. The image's script
# path does not exist in that namespace, so do not ask nsenter to open it there.
exec nsenter -t 1 -m -- /bin/sh -c '
  set -eu
  workspace_host_root="/var/lib/enoughfactory/workspaces/$1"
  workspace_is_mounted() {
    awk -v workspace_mount_path="$1" '\''$5 == workspace_mount_path { found=1 } END { exit !found }'\'' /proc/self/mountinfo
  }
  if [ "$2" = remove ]; then
    while workspace_is_mounted "$workspace_host_root/repo"; do
      # Container and state-volume removal already succeeded. A daemon killed
      # during shutdown can leave a disconnected FUSE mount in the host.
      umount "$workspace_host_root/repo"
    done
    while workspace_is_mounted "$workspace_host_root"; do umount "$workspace_host_root"; done
    rmdir "$workspace_host_root/repo" "$workspace_host_root"
    exit 0
  fi
  mkdir -p "$workspace_host_root"
  if ! workspace_is_mounted "$workspace_host_root"; then
    mount --bind "$workspace_host_root" "$workspace_host_root"
  fi
  mount --make-rshared "$workspace_host_root"
  mkdir -p "$workspace_host_root/repo"
' enoughfactory-shared-mount "$workspace_attempt_id" "$workspace_mount_action"
