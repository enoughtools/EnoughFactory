using System.Net;

using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Backends;

/// <summary>What a session's instance runs on.</summary>
internal enum BackendKind
{
    /// <summary>An Incus daemon: a VM envmux built under Hyper-V, or one it attached to.</summary>
    Incus,

    /// <summary>The Docker engine on this machine.</summary>
    Docker,
}

/// <summary>
/// Where a session's instance lives, and the handful of things a session does to it.
/// </summary>
/// <remarks>
/// <para>
/// Lean on purpose. A session makes a machine, runs commands in it, moves files
/// in and out, and opens connections to its loopback. Those are the only
/// things both Incus and Docker have to be able to do, so they are the only
/// things here. What only one of them has — pinned addresses, snapshots, proxy
/// devices — stays behind its own implementation.
/// </para>
/// <para>
/// There is no reach, no routes and no DNS in it. A session is looked at
/// through the browser proxy, whose connections are <see cref="IExec.DialAsync"/>:
/// a TCP connection made from inside the instance and carried out over the
/// same channel as everything else. That is what lets one seam cover a VM on
/// another machine and a container on this one.
/// </para>
/// <para>
/// The shapes are Incus' wire models (<see cref="Instance"/>, <see cref="InstancesPost"/>),
/// because Incus was here first and the session already speaks them. The Docker
/// implementation translates, and says where it cannot.
/// </para>
/// </remarks>
internal interface IBackend : IAsyncDisposable
{
    /// <summary>What to call it in a message: the host's address, or the engine's.</summary>
    string Name { get; }

    BackendKind Kind { get; }

    IInstances Instances { get; }

    IExec Exec { get; }

    IFiles Files { get; }

    IImages Images { get; }

    /// <summary>
    /// The address on this machine the instance can reach, for the portal's
    /// bridge listener to bind; null when there is none.
    /// </summary>
    /// <remarks>
    /// The one direction that still crosses the boundary on its own: the room
    /// in the instance calling the portal's API here. On Incus it is the
    /// workstation's address that faces the host; on Docker Desktop, loopback,
    /// because <c>host.docker.internal</c> lands there.
    /// </remarks>
    IPAddress? BridgeAddress { get; }

    /// <summary>What the session's own instance is created as.</summary>
    /// <remarks>
    /// The backend's to build, because what a machine is made of differs: a
    /// profile and a nic on Incus, an image and a network on Docker. The session
    /// only says what it wants in it.
    /// </remarks>
    InstancesPost SessionSpec(SessionPlan plan, ImageChoice image);

    /// <summary>What one of the session's services is created as.</summary>
    InstancesPost ServiceSpec(ServicePlan service, SessionPlan plan);

    /// <summary>
    /// Check it answers and will do what is asked, before anything is created.
    /// </summary>
    /// <exception cref="BackendException">It will not, with the reason and the fix.</exception>
    Task PreflightAsync(CancellationToken ct = default);

    /// <summary>
    /// Give the instance a loopback port that is carried out to <paramref name="connectTo"/>
    /// on this machine: the room's way to the portal's API.
    /// </summary>
    /// <returns>Whether it could be done. A backend that cannot says so rather than throwing.</returns>
    Task<bool> TryWireLoopbackAsync(
        string instance,
        string name,
        int insidePort,
        IPEndPoint connectTo,
        CancellationToken ct = default);
}

/// <summary>The machines: made, found, started, stopped, removed.</summary>
internal interface IInstances
{
    Task<IReadOnlyList<Instance>> ListAsync(CancellationToken ct = default);

    Task<Instance?> GetAsync(string name, CancellationToken ct = default);

    /// <param name="report">Progress worth showing — a pull, a copy — as it happens.</param>
    Task CreateAsync(InstancesPost spec, Action<string>? report = null, CancellationToken ct = default);

    Task StartAsync(string name, CancellationToken ct = default);

    Task StopAsync(string name, int timeoutSeconds = 10, CancellationToken ct = default);

    /// <returns>False when there was nothing by that name.</returns>
    Task<bool> DeleteAsync(string name, CancellationToken ct = default);

    /// <summary>
    /// The address the instance holds, once it has one: informational, since
    /// nothing on this machine connects to it.
    /// </summary>
    Task<string?> AwaitAddressAsync(string name, TimeSpan timeout, CancellationToken ct = default);

    /// <summary>
    /// Put the session's environment on the instance itself, where every exec
    /// inherits it, replacing what was there.
    /// </summary>
    /// <remarks>
    /// Best effort, and a no-op where the backend fixes a machine's environment
    /// when it is made: the environment file the session writes covers shells
    /// and tasks either way.
    /// </remarks>
    Task SetEnvironmentAsync(string name, IReadOnlyDictionary<string, string> environment, CancellationToken ct = default);
}

/// <summary>A command to run in an instance.</summary>
internal sealed record ExecRequest
{
    /// <summary>The command, already wrapped for the account it runs as (<see cref="Command.AsUser"/>).</summary>
    public required IReadOnlyList<string> Command { get; init; }

    public string? Cwd { get; init; }

    public IReadOnlyDictionary<string, string>? Environment { get; init; }

    public int Width { get; init; } = 120;

    public int Height { get; init; } = 40;
}

/// <summary>
/// A terminal in an instance: a pty's bytes both ways, a size, signals, and an exit code.
/// </summary>
/// <remarks>
/// <see cref="ExecSession"/>'s surface, because that was the one there was. On
/// Incus the terminal belongs to the connection and closing it ends the
/// command; the Docker implementation has to make that true by hand.
/// </remarks>
internal interface IInteractiveExec : IAsyncDisposable
{
    Stream Terminal { get; }

    Task ResizeAsync(int columns, int rows, CancellationToken ct = default);

    Task SignalAsync(int signal, CancellationToken ct = default);

    /// <summary>What it exited with, or null while it is still running.</summary>
    Task<int?> ExitCodeAsync(CancellationToken ct = default);

    /// <summary>Wait for it to exit, and say with what.</summary>
    Task<int> WaitAsync(CancellationToken ct = default);
}

/// <summary>Running things in an instance, and reaching into its network.</summary>
internal interface IExec
{
    Task<IInteractiveExec> InteractiveAsync(string instance, ExecRequest request, CancellationToken ct = default);

    /// <summary>Run to completion and collect the output, with no terminal.</summary>
    Task<RunResult> CapturedAsync(string instance, ExecRequest request, CancellationToken ct = default);

    /// <summary>
    /// A TCP connection to <paramref name="port"/> on the first of <paramref name="hosts"/>
    /// that answers, made from inside the instance.
    /// </summary>
    /// <remarks>
    /// What the browser proxy and <c>envmux relay</c> are built on. The
    /// addresses are the instance's: <c>127.0.0.1</c> there is its own loopback,
    /// a name is resolved by its DNS.
    /// </remarks>
    /// <returns>The connection, or null when nothing answered.</returns>
    Task<Stream?> DialAsync(
        string instance,
        string user,
        IReadOnlyList<string> hosts,
        int port,
        CancellationToken ct = default);
}

/// <summary>Whole files in and out, the way the repository bundle travels.</summary>
internal interface IFiles
{
    Task PushAsync(
        string instance,
        string path,
        ReadOnlyMemory<byte> content,
        string mode = "0644",
        CancellationToken ct = default);

    /// <returns>The file's bytes, or null when there is no such file.</returns>
    Task<byte[]?> PullAsync(string instance, string path, CancellationToken ct = default);
}

/// <summary>What a session's instance is made from.</summary>
internal interface IImages
{
    /// <summary>
    /// The image or snapshot this session's instance is made from, making it
    /// first if the project needs one of its own, or null for the backend's
    /// fallback image.
    /// </summary>
    /// <param name="report">Progress, and the phase to show while it builds.</param>
    Task<ImageChoice> ChooseAsync(SessionPlan plan, string user, Action<string> report, CancellationToken ct = default);
}

/// <summary>What an instance will be made from, and how to describe it.</summary>
/// <param name="Source">The project image, or null to use the golden one (or the fallback).</param>
/// <param name="Golden">Whether the golden image exists to copy.</param>
/// <param name="Describe">How the log names it: "envmux-golden/base", "debian/13/cloud".</param>
internal sealed record ImageChoice(string? Source, bool Golden, string Describe);
