# Source is supplied by build.sh as an archive of the exact revision in source.json.
FROM golang:1.26.1-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY source/go.mod source/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY source/ .
COPY allow-other.patch /tmp/allow-other.patch
COPY license-notices.go /tmp/license-notices.go
RUN git apply /tmp/allow-other.patch
RUN --mount=type=cache,target=/go/pkg/mod go run /tmp/license-notices.go /licenses
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /artifact-fs ./cmd/artifact-fs

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    fuse3 git ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'user_allow_other\n' >> /etc/fuse.conf
COPY --from=build /artifact-fs /usr/local/bin/artifact-fs
COPY source/LICENSE source/NOTICE /usr/share/licenses/artifact-fs/
COPY --from=build /licenses /usr/share/licenses/artifact-fs/dependencies/
COPY source.json /usr/share/enoughfactory/artifact-fs-source.json
COPY --chmod=0755 manager.sh /usr/local/bin/enoughfactory-workspace-manager
COPY --chmod=0755 shared-mount.sh /usr/local/bin/enoughfactory-shared-mount
ENV ARTIFACT_FS_ROOT=/var/lib/artifact-fs
ENTRYPOINT ["/usr/local/bin/enoughfactory-workspace-manager"]
