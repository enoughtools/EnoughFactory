# The golden image, as an OCI image, for the Docker backend.
#
# On Incus the golden instance is provisioned by Golden.Provision() and
# Golden.InstallAgent() and then snapshotted; a session is a ZFS clone of that
# snapshot. A Docker engine has no snapshot to clone, so the same provisioning
# is expressed here as an image, layer for layer in the same order, and a
# session is a container from it with named volumes for /home and the workdir.
#
# Keep this in step with Golden.cs. The package list is the same list; the
# agent is installed the same way, to the same place, with root's own copy
# removed for the same reason — this image is every session's, and root's
# signed-in agent is not anybody's.
#
# The Docker backend builds it itself, through the engine's API, from the copy
# of this directory that is embedded in the envmux binary
# (Backends/DockerEngine/GoldenContext.cs) — so everything here has to be
# something the engine's CLASSIC builder understands: no `RUN --mount`, no
# `COPY --chmod`, no heredocs. And every file in this directory is part of the
# build context and of the hash the image is tagged with; do not keep anything
# here that is not one.
#
# No systemd: a container runs one process, and envmux starts tmux sessions
# through exec, so nothing needs a service manager. What starts sshd is
# envmux-init, the default command.
#
# Pinned by digest — the multi-arch index, so arm64 still resolves — because
# this is built on people's own machines with nobody reviewing what a moved tag
# brought in. Moving it is a deliberate edit, which changes the hash, which is
# a new tag and an honest rebuild. `docker buildx imagetools inspect
# debian:trixie-slim` prints the current one.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

ENV DEBIAN_FRONTEND=noninteractive

# The host keys openssh-server's postinst generates are removed in the same
# layer that made them: keys in an image are keys every session shares, and a
# later `rm` would leave them readable in the layer underneath. envmux-init
# makes each session its own.
RUN set -eu; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends \
        tmux openssh-server ca-certificates curl git sudo less rsync \
        procps util-linux bash; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/ssh/ssh_host_*; \
    mkdir -p /var/log/envmux; \
    chmod 1777 /var/log/envmux; \
    mkdir -p /etc/skel; \
    printf 'export TERM=${TERM:-xterm-256color}\n' >> /etc/skel/.bashrc

# Claude Code, from Anthropic's installer, moved to a path no account owns.
RUN set -eu; \
    curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh; \
    bash /tmp/claude-install.sh stable >/dev/null 2>&1; \
    binary=$(readlink -f /root/.local/bin/claude); \
    mkdir -p /opt/claude; \
    cp "$binary" /opt/claude/claude; \
    chmod 0755 /opt/claude/claude; \
    ln -sfn /opt/claude/claude /usr/local/bin/claude; \
    rm -rf /root/.local/share/claude /root/.local/bin/claude /root/.claude /tmp/claude-install.sh; \
    claude --version

# What the Docker backend's own plumbing needs, and nothing a session is
# promised. A layer of its own, after the two expensive ones, so that changing
# this list costs an apt run and not the agent's download again.
#
#   socat     the room relay, instance to workstation. perl-base could do it
#             and is the fallback; socat handles a half-closed connection.
#             The browser's relay into a session needs nothing here: it is
#             bash and /dev/tcp (Backends/DockerEngine/EngineRelay.cs).
RUN set -eu; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends socat; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Last, because it is the part that changes. The mode is set here rather than
# trusted from the context: a checkout on Windows has no executable bit to keep.
COPY envmux-init /usr/local/bin/envmux-init
RUN chmod 0755 /usr/local/bin/envmux-init

# The container's one process: sshd for the editor, then wait to be stopped.
# Everything a session does arrives over exec.
CMD ["/usr/local/bin/envmux-init"]
