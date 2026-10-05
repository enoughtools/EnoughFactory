using System.Security.Cryptography;

using Envmux.Host;

namespace Envmux.Docker;

/// <summary>
/// A client's claim on the Docker endpoint, kept alive by a heartbeat.
/// </summary>
/// <remarks>
/// <para>
/// The endpoint is not a daemon: it runs only while something needs it. A lease
/// is how a client says so. It is a file under <see cref="Directory"/> whose
/// modification time <em>is</em> the heartbeat — touched every
/// <see cref="HeartbeatInterval"/> while the client holds it, and treated as
/// dead by the shim once it is older than <see cref="Ttl"/>. So a client that
/// crashes strands nothing: its lease simply stops being touched and expires.
/// </para>
/// <para>
/// A long-lived client — a running session — heartbeats for its lifetime and
/// deletes the file on the way out (<see cref="DisposeAsync"/>). A short-lived
/// one — <c>envmux code</c>, which spawns the editor and leaves — hands off with
/// <see cref="Linger"/>: it stops heartbeating but leaves a fresh file behind,
/// which keeps the shim up for the <see cref="Ttl"/> it takes VS Code to connect
/// and hold a connection of its own.
/// </para>
/// </remarks>
internal sealed class DockerLease : IAsyncDisposable
{
    /// <summary>How often a held lease is touched.</summary>
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(5);

    /// <summary>How old a lease may be before the shim reads it as dead. Comfortably several heartbeats.</summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(20);

    private readonly string _path;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _heartbeat;
    private bool _linger;
    private bool _disposed;

    private DockerLease(string path)
    {
        _path = path;
        _heartbeat = Task.Run(HeartbeatAsync);
    }

    /// <summary>Where leases live, beside the rest of envmux's state.</summary>
    public static string Directory => Path.Combine(HostConfig.Directory, "docker", "leases");

    /// <summary>Take a lease and start heartbeating it.</summary>
    public static DockerLease Acquire()
    {
        System.IO.Directory.CreateDirectory(Directory);
        var path = Path.Combine(Directory, RandomNumberGenerator.GetHexString(16, lowercase: true));

        // The content does not matter — the mtime is the signal — but the pid is
        // there for anyone reading the directory by hand.
        File.WriteAllText(path, Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return new DockerLease(path);
    }

    /// <summary>
    /// Whether any client currently holds the endpoint.
    /// </summary>
    /// <remarks>
    /// Read by the shim's own shutdown monitor. A lease is live if it was touched
    /// within <see cref="Ttl"/>; anything much older is a crashed client's
    /// leftover and is swept as it is found, so the directory does not grow.
    /// </remarks>
    public static bool AnyLive()
    {
        if (!System.IO.Directory.Exists(Directory))
        {
            return false;
        }

        var now = DateTime.UtcNow;
        var live = false;

        foreach (var path in System.IO.Directory.EnumerateFiles(Directory))
        {
            try
            {
                var age = now - File.GetLastWriteTimeUtc(path);

                if (age <= Ttl)
                {
                    live = true;
                }
                else if (age > TimeSpan.FromMinutes(5))
                {
                    // Long dead — a client that never cleaned up. Sweep it.
                    File.Delete(path);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A lease being written or deleted by its owner right now. It
                // will be counted, or not, on the next pass.
            }
        }

        return live;
    }

    /// <summary>Stop heartbeating but leave the file to expire — a hand-off to whatever connects next.</summary>
    public void Linger() => _linger = true;

    private async Task HeartbeatAsync()
    {
        try
        {
            while (!_stop.Token.IsCancellationRequested)
            {
                await Task.Delay(HeartbeatInterval, _stop.Token).ConfigureAwait(false);

                try
                {
                    if (File.Exists(_path))
                    {
                        File.SetLastWriteTimeUtc(_path, DateTime.UtcNow);
                    }
                    else
                    {
                        // Something swept it; put it back rather than silently
                        // dropping the claim.
                        File.WriteAllText(_path, Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    // A transient filesystem hiccup; the next beat catches up, and
                    // one missed beat is well inside the TTL.
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Disposed or lingered; that is the normal way this ends.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        await _stop.CancelAsync().ConfigureAwait(false);

        try
        {
            await _heartbeat.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The heartbeat's own cancellation.
        }

        _stop.Dispose();

        // Lingering leaves the file to expire on its own; otherwise the claim is
        // dropped at once so the shim is not kept up a moment longer than needed.
        if (!_linger)
        {
            try
            {
                File.Delete(_path);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Already gone, or momentarily locked; it expires by TTL regardless.
            }
        }
    }
}
