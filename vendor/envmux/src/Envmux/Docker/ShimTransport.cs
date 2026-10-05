using Envmux.Host;

namespace Envmux.Docker;

/// <summary>The endpoint could not be offered, or a platform has no transport yet.</summary>
internal sealed class ShimException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// One client connection to the endpoint: a duplex stream, and a way to say
/// "nothing more from this side" without closing it.
/// </summary>
/// <remarks>
/// The half-close is the whole reason this is an interface rather than a
/// <see cref="Stream"/>. A hijacked exec ends when the shim has no more
/// output, and the client reads that as EOF — but it may still be sending,
/// and the connection has to stay up until it has read the end. On a socket
/// that is <c>shutdown(SHUT_WR)</c>; on a Windows message pipe it is a
/// zero-length message. Reads returning zero mean the client did the same
/// thing in the other direction, which for a non-tty exec is stdin's EOF.
/// </remarks>
internal interface IShimConnection : IAsyncDisposable
{
    Stream Stream { get; }

    /// <summary>EOF towards the client. The connection stays open for the client to finish reading and close.</summary>
    ValueTask CompleteWriteAsync(CancellationToken ct);
}

/// <summary>Where the endpoint is offered, one platform at a time.</summary>
internal interface IShimListener : IAsyncDisposable
{
    /// <summary>What <c>DOCKER_HOST</c> should be set to, to reach this.</summary>
    string Address { get; }

    /// <summary>The next client, or null once the listener is being taken down.</summary>
    ValueTask<IShimConnection?> AcceptAsync(CancellationToken ct);
}

/// <summary>
/// The endpoint's identity per platform, and the listener that serves it.
/// </summary>
/// <remarks>
/// <para>
/// Windows is served, by <see cref="Windows.MessagePipeListener"/>: a named
/// pipe, per user, in message mode — the mode is not optional, see that class.
/// </para>
/// <para>
/// macOS and Linux use a private unix socket. The singleton lock is held before
/// binding, so a socket left by a crashed endpoint can be removed safely.
/// </para>
/// </remarks>
internal static class ShimEndpoint
{
    public const string PipeName = "envmux-docker";

    public const string SocketFileName = "docker.sock";

    public static string UnixSocketPath => Path.Combine(HostConfig.Directory, SocketFileName);

    /// <summary>The <c>DOCKER_HOST</c> for this machine, whether or not anything is serving it yet.</summary>
    public static string DockerHost =>
        OperatingSystem.IsWindows()
            ? $"npipe:////./pipe/{PipeName}"
            : $"unix://{UnixSocketPath}";

    /// <summary>
    /// Whether something is serving the endpoint right now.
    /// </summary>
    /// <remarks>
    /// A pipe under <c>\\.\pipe\</c> exists exactly while a server instance is
    /// listening. Unix socket files survive a crash, so they need a connection
    /// probe before the editor can trust that the endpoint is up.
    /// </remarks>
    public static bool IsServed()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                return Directory.EnumerateFiles(@"\\.\pipe\")
                    .Any(p => string.Equals(Path.GetFileName(p), PipeName, StringComparison.OrdinalIgnoreCase));
            }
            catch (IOException)
            {
                return false;
            }
        }

        if (!File.Exists(UnixSocketPath))
        {
            return false;
        }

        // A crash leaves the socket file behind. Only a live listener counts.
        try
        {
            using var probe = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.Unix, System.Net.Sockets.SocketType.Stream,
                System.Net.Sockets.ProtocolType.Unspecified);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            probe.ConnectAsync(new System.Net.Sockets.UnixDomainSocketEndPoint(UnixSocketPath), deadline.Token)
                .AsTask().GetAwaiter().GetResult();
            return true;
        }
        catch (Exception e) when (e is System.Net.Sockets.SocketException or OperationCanceledException)
        {
            return false;
        }
    }

    public static IShimListener Listen()
    {
        if (OperatingSystem.IsWindows())
        {
            return new Windows.MessagePipeListener(PipeName);
        }

        return new UnixSocketListener(UnixSocketPath);
    }
}
