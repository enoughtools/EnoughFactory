FROM node:24-trixie

COPY images/dev-common.sh /usr/local/share/envmux/dev-common.sh
RUN /bin/sh /usr/local/share/envmux/dev-common.sh \
    && rm /usr/local/share/envmux/dev-common.sh

# Not root: dev-common.sh renamed the base image's uid 1000 account to `user`,
# and gave it passwordless sudo for the times root is genuinely wanted. A
# project overrides this with `[workspace] user` in its .envmux.toml.
USER user
WORKDIR /work
CMD ["sleep", "infinity"]
