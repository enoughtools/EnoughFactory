using System.Net.Sockets;
using System.Runtime.Versioning;

namespace Envmux.Docker;

/// <summary>The Docker shim's private socket on macOS and Linux.</summary>
/// <remarks>
/// The caller holds the endpoint's singleton lock before constructing this.
/// Bind inside a private directory: chmod on the socket alone leaves a window
/// between bind and chmod in which another account could connect.
/// </remarks>
[UnsupportedOSPlatform("windows")]
internal sealed class UnixSocketListener : IShimListener
{
    private readonly Socket _listener = new(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    private readonly string _path;

    public UnixSocketListener(string path)
    {
        _path = path;
        try
        {
            var directory = Path.GetDirectoryName(path)!;
            RejectLinks(path);
            Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.Delete(path);
            _listener.Bind(new UnixDomainSocketEndPoint(path));
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            _listener.Listen(128);
        }
        catch (Exception e) when (e is IOException or SocketException or UnauthorizedAccessException or ArgumentException)
        {
            _listener.Dispose();
            throw new ShimException($"could not serve the Docker endpoint at {path}: {e.Message}", e);
        }
    }

    /// <summary>Never chmod a linked directory or replace a linked endpoint.</summary>
    /// <remarks>The socket grants command execution, so its path must stay private to this user.</remarks>
    private static void RejectLinks(string path)
    {
        for (var current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            if (new FileInfo(current).LinkTarget is not null)
            {
                throw new ShimException($"the Docker endpoint path contains a link: {current}; choose an unlinked ENVMUX_HOME");
            }
        }
    }

    public string Address => $"unix://{_path}";

    public async ValueTask<IShimConnection?> AcceptAsync(CancellationToken ct)
    {
        try
        {
            return new Connection(await _listener.AcceptAsync(ct).ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (ObjectDisposedException)
        {
            return null;
        }
    }

    public ValueTask DisposeAsync()
    {
        _listener.Dispose();
        File.Delete(_path);
        return default;
    }

    private sealed class Connection(Socket socket) : IShimConnection
    {
        public Stream Stream { get; } = new NetworkStream(socket, ownsSocket: true);

        public ValueTask CompleteWriteAsync(CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                socket.Shutdown(SocketShutdown.Send);
            }
            catch (SocketException)
            {
                // A client that already left has no more output to receive.
            }

            return default;
        }

        public ValueTask DisposeAsync() => Stream.DisposeAsync();
    }
}
