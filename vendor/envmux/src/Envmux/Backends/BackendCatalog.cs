using Envmux.Host;

namespace Envmux.Backends;

/// <summary>
/// Which backend a session runs on, and the one place that knows how to open each.
/// </summary>
/// <remarks>
/// <para>
/// Docker by default: the engine on this machine is there without an install, and a
/// session on it starts without a hop to another host. Incus when asked for —
/// <c>--backend incus</c> or <c>"backend": "incus"</c>. It was once the default whenever
/// a <c>host.json</c> was provisioned, which sent every session to the remote host for
/// anyone who had ever set one up, whether that run wanted it or not.
/// </para>
/// <para>
/// The one switch on <see cref="BackendKind"/>. Anything else that needs to
/// know which backend it has asks the backend, not the kind.
/// </para>
/// </remarks>
internal static class BackendCatalog
{
    /// <summary>What a session runs on when nothing says.</summary>
    public const BackendKind Default = BackendKind.Docker;

    /// <summary>Read a backend's name as the config and the command line write it.</summary>
    /// <returns>The kind, or null when the name is not one.</returns>
    public static BackendKind? Parse(string? name) =>
        name?.Trim().ToLowerInvariant() switch
        {
            "incus" => BackendKind.Incus,
            "docker" => BackendKind.Docker,
            _ => null,
        };

    /// <summary>Open the backend asked for, or the default one.</summary>
    /// <exception cref="BackendException">It cannot be opened here.</exception>
    public static IBackend Open(BackendKind? requested, HostConfig host) =>
        (requested ?? Default) switch
        {
            BackendKind.Incus => IncusBackend.Connect(host),
            _ => DockerBackend.Connect(),
        };
}
