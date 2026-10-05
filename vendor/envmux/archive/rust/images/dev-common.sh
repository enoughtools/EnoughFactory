#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
# docker-cli is listed explicitly: `docker.io` only *Recommends* it, so with
# --no-install-recommends the image gets dockerd and no `docker` command. That
# fails confusingly — the daemon starts fine and every client call reports
# "docker: not found".
apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl docker.io docker-cli fd-find gnupg \
    jq less locales make openssh-client pipx pkg-config python3 python3-pip \
    python3-venv ripgrep shellcheck sudo tmux unzip wget xz-utils zip

# BuildKit for the docker CLI. Debian's client ships without it, and the
# legacy builder rejects BuildKit flags (`unknown flag: --progress`) — which
# is exactly how a nested `envmux` image build inside this image fails.
# envmux degrades to the legacy builder when buildx is absent, but having it
# is strictly better. Best-effort: the package name is present on trixie.
apt-get install -y --no-install-recommends docker-buildx || \
    echo "docker-buildx unavailable; nested builds use the legacy builder"

apt-get install -y --no-install-recommends git git-lfs
rm -rf /var/lib/apt/lists/*

# envmux refuses to start below git 2.40, so an image whose git is older cannot
# run the daemon it exists to develop — which is how this was found: the base
# images shipped Debian Bookworm's 2.39.5 and the nested daemon died on its own
# substrate check. Trixie carries 2.47. Assert it at build time so the failure
# lands here rather than at first use, and so a future base bump cannot
# silently regress it. Note that bookworm-backports does NOT carry git; moving
# the base is the fix, not an apt pin.
git_version="$(git --version | sed 's/^git version //')"
required=2.40
if [ "$(printf '%s\n%s\n' "$required" "$git_version" | sort -V | head -n1)" != "$required" ]; then
    echo "git $git_version is older than the $required envmux requires" >&2
    exit 1
fi
echo "git $git_version (>= $required required by envmux)"

# Debian names these utilities differently from the commands developers expect.
ln -sf /usr/bin/fdfind /usr/local/bin/fd

# AWS CLI v2 publishes separate x86_64 and arm64 bundles.
case "$(dpkg --print-architecture)" in
    amd64) aws_arch=x86_64 ;;
    arm64) aws_arch=aarch64 ;;
    *) echo "unsupported AWS CLI architecture" >&2; exit 1 ;;
esac
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
rm -rf /tmp/aws /tmp/awscliv2.zip

# Agent CLIs intentionally use npm dist-tags: image rebuilds pick up their
# rapidly shipped compatibility/security fixes while the OS/runtime bases stay pinned.
npm install --global --allow-scripts=@anthropic-ai/claude-code,opencode-ai \
    @anthropic-ai/claude-code@latest \
    @openai/codex-security@latest \
    @openai/codex@latest \
    opencode-ai@latest
npm cache clean --force

git lfs install --system
rm -rf /var/cache/apt/* /usr/share/doc/* /usr/share/man/*

# The account these images run as is not root.
#
# The Node base image already carries a uid 1000 account called `node`.
# Renaming it beats adding a second account: uid 1000 is what the human on a
# Linux host almost always is, and the mirror and shadow arrive as bind mounts
# owned by that human. An account at 1001 would read them as a stranger's, and
# a workspace that cannot write its own shadow cannot be captured.
groupmod --new-name user node
usermod --login user --home /home/user --move-home node

# Root where it is genuinely needed — apt, a privileged workspace's dockerd —
# and without a password prompt, since a task window has nobody to answer it.
usermod --append --groups sudo user
if getent group docker >/dev/null 2>&1; then
    usermod --append --groups docker user
fi
printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/envmux-user
chmod 0440 /etc/sudoers.d/envmux-user

# Pre-create the directories envmux named volumes mount over. Docker seeds a
# fresh named volume from whatever the image holds at the mount path,
# *ownership included* — but a path the image does not have is created for the
# mount as root, and a non-root workspace then cannot write the very directory
# the volume exists to persist. /work matters most: the clone lands there.
#
# The toolchain caches are here for the same reason even where the toolchain
# is not: they are the paths the generated starter lists as commented cache
# volumes, and uncommenting one should not need an image rebuild.
mkdir -p /work \
    /home/user/.cache/go-build \
    /home/user/.cache/pip \
    /home/user/.claude \
    /home/user/.codex \
    /home/user/.config/opencode \
    /home/user/.local/share/codex-security \
    /home/user/.npm \
    /home/user/.nuget/packages \
    /home/user/go/pkg/mod
chown -R user:user /work /home/user
# Configurations that deliberately pin `[workspace] user = "root"` — the
# self-hosting demo, which runs a privileged dockerd — keep theirs here.
mkdir -p /root/.cache /root/.config /root/.local/share

# Assert every advertised command is callable, after all of them are installed.
# A packaging change (a split package, a dropped Recommends) then fails the
# build instead of surfacing as a broken task inside somebody's workspace —
# which is exactly how the missing `docker` CLI above was found.
for cmd in aws claude codex docker dockerd fd git jq node npm rg sudo tmux; do
    command -v "$cmd" >/dev/null || { echo "missing command: $cmd" >&2; exit 1; }
done
echo "all advertised commands present"

# And assert the account, for the same reason: a base image that renames or
# renumbers uid 1000 must fail here, not later as a root-owned volume nobody
# can write.
uid="$(id -u user)"
[ "$uid" = "1000" ] || { echo "user is uid $uid, expected 1000" >&2; exit 1; }
[ "$(getent passwd user | cut -d: -f6)" = "/home/user" ] || {
    echo "user's home is not /home/user" >&2; exit 1
}
echo "default account: user (uid 1000, home /home/user, passwordless sudo)"
