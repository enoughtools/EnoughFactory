#!/bin/sh
# Wire one instance to this workstation's live endpoint, and put the guest half
# in place. Everything here is what envmux would do when a session starts.
#
#   sh wire.sh <instance> [<user>]
#
# The transport is an Incus proxy device, which is a built-in: incusd listens on
# 127.0.0.1 inside the instance and connects out to this workstation on the
# instance's behalf. Nothing is configured inside the container, no address is
# baked into an image, and the endpoint moves with the workstation's DHCP lease
# because the device is rewritten when the session starts.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
instance=${1:?usage: wire.sh <instance> [<user>]}
user=${2:-matt}

incus() { dotnet run "$here/incus.cs" -- "$@"; }

# Where the workstation is answering, taken from what the server printed rather
# than guessed. --print starts nothing; it computes the same address the running
# server bound.
url=$(sed -n 's/.*"url": "\(.*\)".*/\1/p' "$here/live.out" | head -1)
[ -n "$url" ] || { echo "wire.sh: no live.out — run restart.sh first" >&2; exit 1; }

target=${url#http://}
echo "wiring $instance -> $target"

# listen inside the instance, connect from the host. The port inside is fixed at
# 8079 so nothing in the guest has to be told where to look; the port outside is
# whatever this workstation's server claimed.
incus api PATCH "1.0/instances/$instance" "$(cat <<JSON
{"devices":{"envmux-live":{
  "type":"proxy",
  "bind":"instance",
  "listen":"tcp:127.0.0.1:8079",
  "connect":"tcp:$target"
}}}
JSON
)" | grep -q '"status":"Success"' || { echo "wire.sh: could not attach the proxy device" >&2; exit 1; }

# The guest half: rclone and fuse3, and the script that puts one task inside its
# own mount namespace with its own key.
{
    cat <<GUEST
set -eu
export DEBIAN_FRONTEND=noninteractive
command -v rclone >/dev/null && command -v fusermount3 >/dev/null || {
  apt-get update -qq
  apt-get install -y -qq rclone fuse3
}
id -u $user >/dev/null 2>&1 || useradd -m -s /bin/bash $user
cat > /usr/local/bin/envmux-live-enter <<'ENVMUX_LIVE_ENTER'
GUEST
    cat "$here/guest-enter.sh"
    cat <<'GUEST'
ENVMUX_LIVE_ENTER
chmod 0755 /usr/local/bin/envmux-live-enter
sh -n /usr/local/bin/envmux-live-enter
rclone version | head -1
echo "guest ready"
GUEST
} | incus exec "$instance"

echo
echo "now, for a task called <task> holding key <key>:"
echo "  echo <key> | envmux-live-enter $user <task> http://127.0.0.1:8079 claude \\"
echo "      /home/$user/.claude projects,file-history,todos -- claude"
