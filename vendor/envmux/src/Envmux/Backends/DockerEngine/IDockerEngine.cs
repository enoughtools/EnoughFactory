namespace Envmux.Backends.DockerEngine;

/// <summary>The Docker engine answered, and the answer was not what was asked for.</summary>
internal sealed class DockerEngineException(string message, Exception? inner = null)
    : BackendException(message, inner)
{
    /// <summary>The HTTP status the engine gave, when it gave one.</summary>
    public int Status { get; init; }

    public bool IsNotFound => Status == 404;

    /// <summary>409: the name is taken. For a network that is how a session's claim on it is lost.</summary>
    public bool IsConflict => Status == 409;
}

/// <summary>
/// The Docker Engine API, as much of it as a session needs and no more.
/// </summary>
/// <remarks>
/// <para>
/// Spoken directly — a named pipe on Windows, a unix socket elsewhere — for the
/// reason envmux speaks to incusd directly: one binary, no runtime dependency it
/// has to explain, and errors that are the engine's own sentences rather than a
/// CLI's exit code.
/// </para>
/// <para>
/// This is the seam the Docker backend's parts are written against, so that the
/// spec, the exec, the files, the images and the prune can each be tested with
/// a fake (<c>FakeDockerEngine</c> in the tests) and built without waiting for
/// the transport. The transport writes the engine's own nested JSON; these
/// shapes are flattened to what envmux sets and reads.
/// </para>
/// </remarks>
internal interface IDockerEngine : IAsyncDisposable
{
    /// <summary>Where this is talking to, for a log line: <c>npipe:////./pipe/docker_engine</c>.</summary>
    string Endpoint { get; }

    Task<EngineVersion> VersionAsync(CancellationToken ct = default);

    // Containers.

    Task<IReadOnlyList<ContainerSummary>> ContainersAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        bool all = true,
        CancellationToken ct = default);

    /// <returns>Null when there is no such container.</returns>
    Task<ContainerInspect?> InspectAsync(string container, CancellationToken ct = default);

    /// <returns>The new container's id.</returns>
    Task<string> CreateContainerAsync(string name, ContainerCreate body, CancellationToken ct = default);

    Task StartAsync(string container, CancellationToken ct = default);

    Task StopAsync(string container, int timeoutSeconds = 10, CancellationToken ct = default);

    /// <returns>False when there was no such container.</returns>
    Task<bool> RemoveAsync(
        string container,
        bool force = true,
        bool volumes = false,
        CancellationToken ct = default);

    /// <summary>
    /// Block until the container is no longer running, and say how it ended.
    /// </summary>
    /// <remarks>
    /// One that has already exited answers at once, so create, start, wait is
    /// not a race. One that removes itself (<see cref="ContainerCreate.AutoRemove"/>)
    /// can be gone before the wait is asked for, which is a 404: a caller that
    /// wants the exit code does not also want <c>AutoRemove</c>.
    /// </remarks>
    /// <returns>The exit code.</returns>
    Task<int> WaitAsync(string container, CancellationToken ct = default);

    /// <returns>The new image's id.</returns>
    Task<string> CommitAsync(string container, string repository, string tag, CancellationToken ct = default);

    // Exec.

    /// <returns>The exec's id.</returns>
    Task<string> ExecCreateAsync(string container, ExecCreate body, CancellationToken ct = default);

    /// <summary>
    /// The hijacked connection: raw bytes both ways with a tty, stdcopy-framed
    /// output without one (<see cref="StdCopyReader"/> takes that apart).
    /// </summary>
    Task<Stream> ExecStartAsync(string execId, bool tty, CancellationToken ct = default);

    Task ExecResizeAsync(string execId, int columns, int rows, CancellationToken ct = default);

    Task<ExecInspect> ExecInspectAsync(string execId, CancellationToken ct = default);

    // Files: the archive endpoints, which take and give a tar.

    Task PutArchiveAsync(string container, string directory, Stream tar, CancellationToken ct = default);

    /// <returns>Null when the path does not exist.</returns>
    Task<Stream?> GetArchiveAsync(string container, string path, CancellationToken ct = default);

    // Networks.

    Task<IReadOnlyList<NetworkSummary>> NetworksAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default);

    /// <summary>
    /// A bridge network of the engine's own choosing of addresses.
    /// </summary>
    /// <returns>
    /// False when the name was already taken. Network names are unique on an
    /// engine, so that is an answer a caller races on, not an exception.
    /// </returns>
    Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default);

    /// <summary>
    /// <see cref="CreateNetworkAsync(string, IReadOnlyDictionary{string, string}, CancellationToken)"/>
    /// with the network's own address range said, rather than taken from the engine's pools.
    /// </summary>
    /// <remarks>
    /// The default pools hold about thirty bridge networks on Docker Desktop
    /// (measured: eighteen were left on a machine with a dozen of the person's
    /// own), and a network per session is meant to outlast that. A subnet that
    /// overlaps a network already on the engine is refused with a 403, which is
    /// an exception here and not <c>false</c>: the name was not taken, the
    /// addresses were, and only the caller knows whether to try other ones.
    /// </remarks>
    /// <param name="subnet"><c>10.3.7.0/24</c>; null leaves it to the engine.</param>
    /// <param name="gateway"><c>10.3.7.1</c>; null is the subnet's first address.</param>
    Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        string? subnet,
        string? gateway = null,
        CancellationToken ct = default);

    /// <returns>False when there was no such network.</returns>
    Task<bool> RemoveNetworkAsync(string name, CancellationToken ct = default);

    // Volumes.

    Task<IReadOnlyList<VolumeSummary>> VolumesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default);

    Task CreateVolumeAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default);

    /// <returns>False when there was no such volume.</returns>
    Task<bool> RemoveVolumeAsync(string name, CancellationToken ct = default);

    // Images.

    /// <returns>Null when the engine has no such image.</returns>
    Task<ImageInspect?> ImageAsync(string reference, CancellationToken ct = default);

    /// <summary>The images that carry every one of these labels — what <c>prune --images</c> looks through.</summary>
    Task<IReadOnlyList<ImageInspect>> ImagesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default);

    Task PullAsync(string reference, Action<string>? report = null, CancellationToken ct = default);

    /// <summary>Build from a tar context that has a <c>Dockerfile</c> at its root.</summary>
    Task BuildAsync(
        Stream tarContext,
        string tag,
        IReadOnlyDictionary<string, string>? labels = null,
        Action<string>? report = null,
        CancellationToken ct = default);

    /// <returns>False when there was no such image.</returns>
    Task<bool> RemoveImageAsync(string reference, CancellationToken ct = default);
}

/// <summary>
/// What the stream <see cref="IDockerEngine.ExecStartAsync"/> returns also is:
/// a way to say "stdin has ended" without hanging up.
/// </summary>
/// <remarks>
/// A push is <c>cat &gt; file</c> with the file on stdin, and <c>cat</c> ends
/// when its input does — but the connection has to stay open for the output
/// and the exit that follow. Disposing the stream is hanging up; this is the
/// half of it that only ends the input. Ask with <c>stream as IHalfClose</c>:
/// the real client's stream always is one, and a fake's may be.
/// </remarks>
internal interface IHalfClose
{
    ValueTask CompleteWriteAsync(CancellationToken ct = default);
}

internal sealed record EngineVersion(string Version, string ApiVersion, string Os, string Arch, string? Platform);

internal sealed record ContainerSummary(
    string Id,
    IReadOnlyList<string> Names,
    string Image,
    string State,
    IReadOnlyDictionary<string, string> Labels);

/// <summary>One published port: the container's <c>5173/tcp</c> on the host's <c>127.0.0.1:5173</c>.</summary>
/// <remarks>
/// The engine can do it, so the client can say it. A session's container
/// publishes nothing — it is reached through the SOCKS relay (<c>EngineRelay</c>) —
/// and <c>DockerSpec</c> never sets one; this exists for what is read back
/// from containers that are not sessions.
/// </remarks>
internal sealed record PortBinding(int ContainerPort, string HostIp, int HostPort, string Protocol = "tcp");

/// <summary>A mount: <c>volume</c>, <c>bind</c> or <c>tmpfs</c>.</summary>
internal sealed record MountSpec(string Type, string Source, string Target, bool ReadOnly = false, string? Propagation = null);

/// <summary>
/// What a container is created from: the engine's <c>Config</c> and
/// <c>HostConfig</c>, flattened to the fields envmux sets.
/// </summary>
internal sealed record ContainerCreate
{
    public required string Image { get; init; }

    public IReadOnlyList<string>? Entrypoint { get; init; }

    public IReadOnlyList<string>? Cmd { get; init; }

    public string? Hostname { get; init; }

    public string? User { get; init; }

    public string? WorkingDir { get; init; }

    public bool Tty { get; init; }

    /// <summary>Docker's own tiny init as PID 1, so orphans are reaped and signals arrive.</summary>
    public bool Init { get; init; } = true;

    public IReadOnlyDictionary<string, string> Env { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, string> Labels { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public IReadOnlyList<PortBinding> Ports { get; init; } = [];

    public IReadOnlyList<MountSpec> Mounts { get; init; } = [];

    /// <summary>The one network the container is attached to.</summary>
    public string? Network { get; init; }

    /// <summary>The names it answers to on that network, which is how a service is found.</summary>
    public IReadOnlyList<string> NetworkAliases { get; init; } = [];

    /// <summary><c>host.docker.internal:host-gateway</c> and the like.</summary>
    public IReadOnlyList<string> ExtraHosts { get; init; } = [];

    public IReadOnlyList<string> CapAdd { get; init; } = [];

    public IReadOnlyList<string> SecurityOpt { get; init; } = [];

    public long? MemoryBytes { get; init; }

    public long? NanoCpus { get; init; }

    /// <summary>Namespaced kernel settings for the container's own network stack.</summary>
    public IReadOnlyDictionary<string, string> Sysctls { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// Overrides <see cref="Network"/> when set: <c>container:&lt;name&gt;</c> joins another
    /// container's network namespace, which is how a short-lived helper does something in
    /// a session's stack without the session ever holding the capability it takes.
    /// </summary>
    public string? NetworkMode { get; init; }

    /// <summary>Remove the container when it exits. For one-shot helpers only.</summary>
    public bool AutoRemove { get; init; }

    /// <summary>Supplementary group ids for the container's user.</summary>
    public IReadOnlyList<string> GroupAdd { get; init; } = [];
}

internal sealed record ContainerInspect(
    string Id,
    string Name,
    string Image,
    string Status,
    bool Running,
    int? ExitCode,
    IReadOnlyDictionary<string, string> Labels,
    IReadOnlyList<PortBinding> Ports,
    IReadOnlyList<MountSpec> Mounts,
    IReadOnlyDictionary<string, string> NetworkAddresses);

internal sealed record ExecCreate
{
    public required IReadOnlyList<string> Cmd { get; init; }

    public bool Tty { get; init; }

    public bool AttachStdin { get; init; }

    public string? User { get; init; }

    public string? WorkingDir { get; init; }

    public IReadOnlyDictionary<string, string>? Env { get; init; }

    /// <summary>The terminal's size at birth, so the first screen is not drawn at 80x24 and then redrawn.</summary>
    public (int Columns, int Rows)? ConsoleSize { get; init; }
}

internal sealed record ExecInspect(bool Running, int? ExitCode, int Pid);

internal sealed record NetworkSummary(string Id, string Name, IReadOnlyDictionary<string, string> Labels);

internal sealed record VolumeSummary(string Name, IReadOnlyDictionary<string, string> Labels);

internal sealed record ImageInspect(
    string Id,
    IReadOnlyList<string> RepoTags,
    IReadOnlyDictionary<string, string> Labels)
{
    /// <summary>When the image was made, when the engine said.</summary>
    public DateTimeOffset? Created { get; init; }
}
