# ArtifactFS workspace runtime

EnoughFactory uses Cloudflare ArtifactFS through the Enough Tools RepoReach fork,
at commit `6a62f2f34aebe75da3d8b917131a6ace185928e5`.

- Original project: https://github.com/cloudflare/artifact-fs
- Pinned fork: https://github.com/enoughtools/reporeach/tree/6a62f2f34aebe75da3d8b917131a6ace185928e5
- License: Apache License, Version 2.0. The image retains the fork's LICENSE and NOTICE.
- EnoughFactory patch: `allow-other.patch` enables access and write permissions
  for envmux's container user on this attempt's private mount. ArtifactFS reports
  the manager's UID and ignores chown; this patch makes private files writable by
  the configured container user while preserving Git's executable bit. The
  source repository is unchanged. Mounting remains in the manager.

`build.sh` archives the pinned committed source, builds its Go CLI for the Linux
image architecture and records source, revision and license image labels.

This image is optional. Ordinary Git remains the compatible workspace fallback.

Build with `bash runtime/workspaces/build.sh`. `ENOUGHFACTORY_ARTIFACTFS_SOURCE`
may point to a local checkout containing the pinned commit. Run the one real
mount/recovery journey with `pnpm exec tsx runtime/workspaces/verify.mts`.

The trusted mount helper uses the Linux Docker host's mount namespace, including
the Linux VM on Mac. Environments denying shared mounts or `/dev/fuse` use the
ordinary Git provider and expose that reason. Agents receive only the isolated
mount plus its Git state volume, with no manager capabilities or Docker socket.
