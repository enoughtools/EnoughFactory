FROM node:24-trixie

COPY images/dev-common.sh /usr/local/share/envmux/dev-common.sh
RUN /bin/sh /usr/local/share/envmux/dev-common.sh \
    && rm /usr/local/share/envmux/dev-common.sh
RUN wget -q https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb -O /tmp/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-10.0 \
    && rm -rf /var/lib/apt/lists/*

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    NUGET_XMLDOC_MODE=skip
# Not root; see default.Dockerfile. The NuGet package directory the starter
# offers as a cache volume is already created and owned by `user` in
# dev-common.sh, so mounting one over it stays writable.
USER user
WORKDIR /work
EXPOSE 5000 5001
CMD ["sleep", "infinity"]
