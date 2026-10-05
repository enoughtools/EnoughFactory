using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Docker;

/// <summary>
/// The Docker endpoint, running: accept connections, serve HTTP on each,
/// translate every request to the host.
/// </summary>
/// <remarks>
/// One translator (<see cref="DockerShim"/>) shared across connections — its
/// state is the shim state and the event listeners, both guarded — and one
/// <see cref="ShimHttp"/> per connection. A connection lives until the client
/// closes it or a hijacked exec on it ends; each runs on its own task so a
/// long-lived exec does not hold the accept loop.
/// </remarks>
internal sealed class ShimServer : IAsyncDisposable
{
    /// <summary>How often the auto-shutdown monitor checks whether anything still needs the endpoint.</summary>
    private static readonly TimeSpan MonitorInterval = TimeSpan.FromSeconds(5);

    /// <summary>
    /// How long the endpoint stays up after the last lease and connection go.
    /// </summary>
    /// <remarks>
    /// A little longer than a lease's TTL, so the common hand-off — <c>envmux
    /// code</c> leaves a lingering lease, VS Code connects, the lease expires —
    /// never has a gap where nothing holds the endpoint and it closes out from
    /// under the connecting editor.
    /// </remarks>
    private static readonly TimeSpan IdleGrace = TimeSpan.FromSeconds(30);

    private readonly IShimListener _listener;
    private readonly DockerShim _shim;
    private readonly Action<string> _log;

    private int _openConnections;
    private long _lastActivityTicks = DateTime.UtcNow.Ticks;

    private ShimServer(IShimListener listener, DockerShim shim, Action<string> log)
    {
        _listener = listener;
        _shim = shim;
        _log = log;
    }

    /// <summary>What <c>DOCKER_HOST</c> should be to reach this endpoint.</summary>
    public string Address => _listener.Address;

    public static ShimServer Start(IncusApi api, HostConfig host, Action<string>? log = null)
    {
        var report = log ?? (_ => { });
        var state = ShimState.Load();
        var shim = new DockerShim(api, host, state, report);
        var listener = ShimEndpoint.Listen();

        return new ShimServer(listener, shim, report);
    }

    /// <summary>
    /// Serve until cancelled — or, when <paramref name="autoShutdown"/> is set,
    /// until nothing holds the endpoint any more.
    /// </summary>
    /// <param name="ct">Stops the endpoint (Ctrl-C, or the process ending).</param>
    /// <param name="autoShutdown">
    /// Close the endpoint once there is no live lease and no open connection for
    /// <see cref="IdleGrace"/>. This is how the auto-launched endpoint tidies
    /// itself away; a manual <c>envmux docker</c> passes false and stays up.
    /// </param>
    public async Task RunAsync(CancellationToken ct, bool autoShutdown = false)
    {
        _log($"envmux docker endpoint on {_listener.Address}");

        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var monitor = autoShutdown ? MonitorAsync(stopping) : Task.CompletedTask;

        try
        {
            while (!stopping.Token.IsCancellationRequested)
            {
                IShimConnection? connection;

                try
                {
                    connection = await _listener.AcceptAsync(stopping.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                if (connection is null)
                {
                    break;
                }

                Touch();
                _ = Task.Run(() => ServeAsync(connection, stopping.Token), CancellationToken.None);
            }
        }
        finally
        {
            if (!stopping.IsCancellationRequested)
            {
                await stopping.CancelAsync().ConfigureAwait(false);
            }

            await monitor.ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Watch for the endpoint becoming unneeded, and stop it when it does.
    /// </summary>
    /// <remarks>
    /// Two signals keep it alive: a live lease (a client still wants it), and an
    /// open connection (an editor is attached right now). The connection check is
    /// what stops a session quitting — its lease gone — from severing a VS Code
    /// window that is still using the endpoint. Only when both are absent, and
    /// have been for <see cref="IdleGrace"/>, does it close.
    /// </remarks>
    private async Task MonitorAsync(CancellationTokenSource stopping)
    {
        try
        {
            while (!stopping.Token.IsCancellationRequested)
            {
                await Task.Delay(MonitorInterval, stopping.Token).ConfigureAwait(false);

                if (Volatile.Read(ref _openConnections) > 0 || DockerLease.AnyLive())
                {
                    Touch();
                    continue;
                }

                var idle = DateTime.UtcNow - new DateTime(Volatile.Read(ref _lastActivityTicks), DateTimeKind.Utc);

                if (idle >= IdleGrace)
                {
                    _log("no leases and nothing attached — closing the Docker endpoint");
                    await stopping.CancelAsync().ConfigureAwait(false);
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The endpoint is stopping for another reason; nothing to do.
        }
    }

    private void Touch() => Volatile.Write(ref _lastActivityTicks, DateTime.UtcNow.Ticks);

    private async Task ServeAsync(IShimConnection connection, CancellationToken ct)
    {
        Interlocked.Increment(ref _openConnections);

        try
        {
            await using var http = new ShimHttp(connection.Stream);
            await http.ServeAsync((request, response) => _shim.HandleAsync(request, response, connection, ct), ct)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or ShimProtocolException
                                      or ObjectDisposedException or OperationCanceledException)
        {
            // One connection failing is one editor window, not the endpoint.
        }
        finally
        {
            Interlocked.Decrement(ref _openConnections);
            Touch();
            await connection.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _listener.DisposeAsync().ConfigureAwait(false);
    }
}
