#!/usr/bin/env bash
set -euo pipefail
workspace_runtime_dir=$(cd "$(dirname "$0")" && pwd)
workspace_revision=6a62f2f34aebe75da3d8b917131a6ace185928e5
workspace_source=${ENOUGHFACTORY_ARTIFACTFS_SOURCE:-}
workspace_image=${ENOUGHFACTORY_ARTIFACTFS_IMAGE:-enoughfactory/artifactfs:6a62f2f34aeb}
workspace_context=$(mktemp -d)
trap 'rm -rf "$workspace_context"' EXIT
mkdir "$workspace_context/source"
if [ -z "$workspace_source" ]; then
  git clone --no-checkout https://github.com/enoughtools/reporeach.git "$workspace_context/checkout"
  workspace_source="$workspace_context/checkout"
fi
# Archive the committed tree, never uncommitted local modifications.
git -C "$workspace_source" cat-file -e "$workspace_revision^{commit}"
git -C "$workspace_source" archive "$workspace_revision" | tar -x -C "$workspace_context/source"
cp "$workspace_runtime_dir/Dockerfile" "$workspace_runtime_dir/source.json" \
  "$workspace_runtime_dir/allow-other.patch" "$workspace_runtime_dir/manager.sh" \
  "$workspace_runtime_dir/shared-mount.sh" "$workspace_runtime_dir/license-notices.go" "$workspace_context/"
docker build --label "org.opencontainers.image.source=https://github.com/enoughtools/reporeach" \
  --label "org.opencontainers.image.revision=$workspace_revision" \
  --label 'org.opencontainers.image.licenses=Apache-2.0' \
  --tag "$workspace_image" "$workspace_context"
