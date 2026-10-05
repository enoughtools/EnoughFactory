using Envmux.Commands;
using ProcessStartInfo = System.Diagnostics.ProcessStartInfo;

namespace Envmux.Docker;

/// <summary>
/// A machine-wide lock that outlives no process: a file held open with no
/// sharing.
/// </summary>
/// <remarks>
/// A named <see cref="System.Threading.Mutex"/> is the obvious tool and the
/// wrong one here — it has thread affinity, and this is held across
/// <c>await</c>s whose continuations land on whatever thread is free, so
/// releasing it throws. A file opened <see cref="FileShare.None"/> has no such
/// affinity, and it is crash-safe for free: when the holder dies the OS closes
/// the handle and the lock is gone, exactly as an abandoned mutex would be.
/// </remarks>
internal static class MachineLock
{
    /// <summary>Take the lock if it is free right now, or return null.</summary>
    public static FileStream? TryAcquire(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        try
        {
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>Wait for the lock, up to a deadline.</summary>
    public static async Task<FileStream?> AcquireAsync(string path, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            if (TryAcquire(path) is { } stream)
            {
                return stream;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), ct).ConfigureAwait(false);
        }

        return null;
    }
}

/// <summary>
/// Making sure the Docker endpoint is up, and holding a claim on it.
/// </summary>
/// <remarks>
/// <para>
/// The endpoint is a machine-wide singleton with no resident daemon: it is
/// launched on demand and closes itself once nothing holds it (§ the shim's
/// auto-shutdown, and <see cref="DockerLease"/>). A client that wants to attach
/// an editor calls <see cref="EnsureAsync"/> — it takes a lease, and if nothing
/// is serving yet, spawns <c>envmux docker --auto</c> and waits for it.
/// </para>
/// <para>
/// One process must win the launch when several clients want it at once — two
/// listeners on one pipe name would both accept and neither would be whole — so
/// the spawn is serialised by <see cref="LaunchLockPath"/>, and the endpoint
/// itself refuses to start a second time by holding <see cref="SingletonLockPath"/>.
/// </para>
/// </remarks>
internal static class DockerEndpoint
{
    /// <summary>Where the two lock files live, beside the leases and the endpoint's log.</summary>
    private static string LockDirectory => Path.Combine(Host.HostConfig.Directory, "docker");

    /// <summary>Serialises the "is it up? no — launch it" decision across clients.</summary>
    public static string LaunchLockPath => Path.Combine(LockDirectory, "launch.lock");

    /// <summary>Held by whichever process is the endpoint, so a second one steps aside.</summary>
    public static string SingletonLockPath => Path.Combine(LockDirectory, "endpoint.lock");

    private static readonly TimeSpan LaunchWait = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Take a lease on the endpoint, launching it if nothing is serving yet.
    /// </summary>
    /// <returns>The lease. Dispose it to release the claim; <see cref="DockerLease.Linger"/> to hand off.</returns>
    /// <exception cref="ShimException">The endpoint is not available on this platform, or would not come up.</exception>
    public static async Task<DockerLease> EnsureAsync(Action<string>? report = null, CancellationToken ct = default)
    {
        var log = report ?? (_ => { });

        // The lease first, so that by the time anything is serving there is
        // already a reason for it to stay up.
        var lease = DockerLease.Acquire();

        if (ShimEndpoint.IsServed())
        {
            return lease;
        }

        try
        {
            await LaunchAsync(log, ct).ConfigureAwait(false);
        }
        catch
        {
            await lease.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        return lease;
    }

    private static async Task LaunchAsync(Action<string> log, CancellationToken ct)
    {
        // Only one client spawns; the rest wait on the lock and then find it
        // already up. If the lock cannot be had in time, someone else holds it
        // and is launching — fall through to waiting for the pipe.
        using var launch = await MachineLock.AcquireAsync(LaunchLockPath, LaunchWait, ct).ConfigureAwait(false);

        // Whether this client won the lock or not, it may already be serving.
        if (ShimEndpoint.IsServed())
        {
            return;
        }

        if (launch is not null)
        {
            var exe = Environment.ProcessPath
                ?? throw new ShimException("could not find envmux's own path to launch the Docker endpoint");

            log("launching the Docker endpoint");

            var info = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            // A framework-dependent invocation runs inside dotnet, whose first
            // argument must be this assembly rather than the subcommand.
            if (string.Equals(Path.GetFileNameWithoutExtension(exe), "dotnet", StringComparison.OrdinalIgnoreCase))
            {
                info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "envmux.dll"));
            }

            info.ArgumentList.Add("docker");
            info.ArgumentList.Add("--auto");

            try
            {
                using var process = System.Diagnostics.Process.Start(info)
                    ?? throw new ShimException("the Docker endpoint process did not start");
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                throw new ShimException($"could not launch the Docker endpoint: {e.Message}", e);
            }
        }

        await WaitServedAsync(ct).ConfigureAwait(false);
        log("the Docker endpoint is up");
    }

    private static async Task WaitServedAsync(CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + LaunchWait;

        while (DateTime.UtcNow < deadline)
        {
            if (ShimEndpoint.IsServed())
            {
                return;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(150), ct).ConfigureAwait(false);
        }

        throw new ShimException(
            $"the Docker endpoint did not come up. Try `{CommandName.Current} docker` in a terminal to see why.");
    }
}
