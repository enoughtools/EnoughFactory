using Envmux.Config;
using Envmux.Incus;

namespace Envmux.Backends.DockerEngine;

/// <summary>The one manager-owned ArtifactFS workspace allowed by private bootstrap.</summary>
internal sealed class MachineWorkspaceBinding
{
    public const string MountRoot = "/var/lib/enoughfactory/workspaces/";
    public const string StateTarget = "/var/lib/artifact-fs";
    public const string GitWorktreeTarget = "/mount/repo";
    private const string VolumePrefix = "enoughfactory-afs-";

    private MachineWorkspaceBinding(string source, string stateVolume, string workdir)
    {
        Source = source;
        StateVolume = stateVolume;
        Workdir = workdir;
    }

    public string Source { get; }
    public string StateVolume { get; }
    public string Workdir { get; }

    public IReadOnlyList<MountSpec> BindMounts => Workdir == GitWorktreeTarget
        ? [new MountSpec("bind", Source, Workdir, Propagation: "rslave")]
        : [new MountSpec("bind", Source, Workdir, Propagation: "rslave"),
            new MountSpec("bind", Source, GitWorktreeTarget, Propagation: "rslave")];

    public IReadOnlyList<string> TrustedGitPaths => Workdir == GitWorktreeTarget
        ? [Workdir] : [Workdir, GitWorktreeTarget];

    public static MachineWorkspaceBinding? Current(string workdir) => Parse(MachineBridge.Active,
        Environment.GetEnvironmentVariable("ENVMUX_WORKSPACE_BIND"),
        Environment.GetEnvironmentVariable("ENVMUX_ARTIFACT_STATE_VOLUME"), workdir);

    public static MachineWorkspaceBinding? ForSpec(InstancesPost spec)
    {
        if (DockerSpec.IsService(spec))
        {
            return null;
        }

        var workdir = spec.Config?.GetValueOrDefault(DockerSpec.Keys.Workdir);
        return Current(string.IsNullOrEmpty(workdir) ? SessionConfig.DefaultWorkdir : workdir);
    }

    public static MachineWorkspaceBinding? Parse(bool privateBootstrap, string? source, string? stateVolume, string workdir)
    {
        if (!privateBootstrap || (string.IsNullOrEmpty(source) && string.IsNullOrEmpty(stateVolume)))
        {
            return null;
        }

        if (source is null || stateVolume is null || source.Length <= MountRoot.Length + 5 ||
            !source.StartsWith(MountRoot, StringComparison.Ordinal) || !source.EndsWith("/repo", StringComparison.Ordinal))
        {
            throw new BackendException("ArtifactFS workspace requires a manager-owned mount and its state volume");
        }

        var identity = source[MountRoot.Length..^5];
        if (identity.Length is < 1 or > 80 || !identity.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ||
            stateVolume != VolumePrefix + identity)
        {
            throw new BackendException("ArtifactFS mount and state volume must name the same attempt");
        }

        if (!workdir.StartsWith('/') || workdir == "/" ||
            workdir.Split('/').Skip(1).Any(part => part.Length == 0 || part is "." or "..") ||
            Overlaps(workdir, StateTarget) || Overlaps(workdir, "/home") ||
            (workdir != GitWorktreeTarget && Overlaps(workdir, GitWorktreeTarget)))
        {
            throw new BackendException("ArtifactFS workdir must be an absolute directory separate from home and ArtifactFS state");
        }

        return new MachineWorkspaceBinding(source, stateVolume, workdir);
    }

    public bool Allows(ContainerCreate container, MountSpec mount) =>
        container.Labels.GetValueOrDefault(DockerSpec.Labels.Kind) == DockerSpec.SessionKind &&
        BindMounts.Contains(mount) && BindMounts.All(container.Mounts.Contains) &&
        container.Mounts.Contains(new MountSpec("volume", StateVolume, StateTarget));

    private static bool Overlaps(string first, string second) => first == second ||
        first.StartsWith(second + "/", StringComparison.Ordinal) || second.StartsWith(first + "/", StringComparison.Ordinal);
}
