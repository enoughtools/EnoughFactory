FROM node:24-trixie

ARG RUST_TOOLCHAIN=1.95.0
COPY images/dev-common.sh /usr/local/share/envmux/dev-common.sh
RUN /bin/sh /usr/local/share/envmux/dev-common.sh \
    && rm /usr/local/share/envmux/dev-common.sh

# Rust lives in /usr/local, not in a home directory: the image runs as `user`,
# /root is unreadable to it, and a toolchain in /home/user would be shadowed
# the moment somebody mounted a volume over part of that home. Group/other
# writable so cargo can still write the registry and git checkouts — the two
# paths a cache volume normally mounts over.
#
# `ENV PATH` alone does not carry it: Debian's /etc/profile *assigns* PATH
# rather than extending it, so a login shell — an attached workspace shell,
# `sh -lc` in CI — drops every directory outside the standard set, and cargo
# goes missing in exactly the places a human looks for it. The profile.d drop
# below runs after that assignment and puts it back.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH} \
    CARGO_INCREMENTAL=0
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" \
       --component clippy --component rustfmt \
    && rm /tmp/rustup.sh \
    && mkdir -p "${CARGO_HOME}/registry" "${CARGO_HOME}/git" \
    && chmod -R a+rwX "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && printf 'export PATH=%s/bin:$PATH\n' "${CARGO_HOME}" > /etc/profile.d/rust.sh \
    && chmod 0644 /etc/profile.d/rust.sh

USER user
WORKDIR /work
EXPOSE 8000
CMD ["sleep", "infinity"]
