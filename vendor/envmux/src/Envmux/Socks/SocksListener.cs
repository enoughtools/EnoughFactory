using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Envmux.Socks;

/// <summary>Where one connection is dialled from.</summary>
internal enum SocksRoute
{
    /// <summary>From inside the instance, over an exec.</summary>
    Instance,

    /// <summary>From this machine.</summary>
    Local,
}

/// <summary>
/// The session's SOCKS5 port: claimed when the session starts, on loopback,
/// released when the process ends.
/// </summary>
/// <remarks>
/// <para>
/// The claim works the way the portal's does: a held socket, walking up
/// <see cref="SocksPlan.Port"/> until one binds, bound exclusively so another
/// process cannot share it. There is no lease to go stale. The port says which
/// session a connection is for. It does not say the connection is allowed.
/// </para>
/// <para>
/// A connection is let in if it sends this session's username and password
/// (RFC 1929), or, when it offers no password, if the process on the other end
/// is a browser this session launched or one of that browser's children
/// (<see cref="ConnectionOwner"/>). Anything else is told there is no method it
/// can use, and a line in the log says which process it was.
/// </para>
/// <para>
/// Then the loopback — <c>localhost</c>, <c>127/8</c>, <c>[::1]</c> — goes into
/// the instance, and everything else goes where <see cref="SocksPlan.Egress"/>
/// says: this machine by default, so maps, fonts and single sign-on behave the
/// way they do in any other browser here.
/// </para>
/// <para>
/// A loopback port with nothing on it is refused, unless the session expects
/// something there, in which case the request is answered here with
/// <see cref="LoadingPage"/> until it arrives.
/// </para>
/// </remarks>
internal sealed class SocksListener : IAsyncDisposable
{
    /// <summary>How long a dial from this machine may take.</summary>
    private static readonly TimeSpan LocalDialTimeout = TimeSpan.FromSeconds(15);

    /// <summary>How long a client has to finish the handshake before it is dropped.</summary>
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(10);

    private readonly SocksPlan _plan;
    private readonly LaunchedBrowsers _launched;
    private readonly Func<IReadOnlyList<string>, int, CancellationToken, Task<Stream?>> _dialInstance;
    private readonly Session.SessionLog _log;
    private readonly Func<int, ExpectedPort?>? _expected;
    private readonly CancellationTokenSource _stopping = new();
    private readonly HashSet<int> _refused = [];
    private TcpListener? _listener;

    /// <param name="plan">What to claim, and the credentials.</param>
    /// <param name="launched">The browsers let in without a password.</param>
    /// <param name="dialInstance">
    /// Dial a port on the first of some addresses, from inside the instance; null when nothing answered.
    /// </param>
    /// <param name="log">Where refusals and failed dials are said.</param>
    /// <param name="expected">
    /// Whether a loopback port is one the session expects something on, for
    /// <see cref="LoadingPage"/>; null when nothing is expected anywhere.
    /// </param>
    public SocksListener(
        SocksPlan plan,
        LaunchedBrowsers launched,
        Func<IReadOnlyList<string>, int, CancellationToken, Task<Stream?>> dialInstance,
        Session.SessionLog log,
        Func<int, ExpectedPort?>? expected = null)
    {
        _expected = expected;
        _plan = plan;
        _launched = launched;
        _dialInstance = dialInstance;
        _log = log;
    }

    /// <summary>The port claimed, or 0 before <see cref="Start"/>.</summary>
    public int Port { get; private set; }

    /// <summary>
    /// The proxy with the credentials this listener checks.
    /// </summary>
    /// <remarks>
    /// From the listener rather than the session's plan: a restart re-reads the
    /// config and mints a new plan, but the port and the password it holds are
    /// the ones claimed at start.
    /// </remarks>
    public string Url => _plan.Url(Port);

    /// <summary>Where a connection to <paramref name="target"/> is dialled from.</summary>
    /// <remarks>
    /// The loopback always goes in, and so does any name under the session's
    /// <paramref name="domain"/>: those are its own instance and its services,
    /// named by the host's DNS and resolved nowhere on this machine. So a
    /// database client pointed at the proxy reaches <c>…-db.envmux:5432</c>
    /// with local egress too. Everything else goes where the egress says.
    /// </remarks>
    public static SocksRoute Choose(SocksTarget target, Egress egress, string domain = "") =>
        target.IsLoopback || egress == Egress.Instance || IsUnder(target.Host, domain)
            ? SocksRoute.Instance
            : SocksRoute.Local;

    private static bool IsUnder(string host, string domain) =>
        domain.Length > 0 &&
        (host.Equals(domain, StringComparison.OrdinalIgnoreCase) ||
         host.EndsWith("." + domain, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Claim the first free port in the plan's range and start answering.
    /// </summary>
    /// <exception cref="SocksException">Every port in the range is taken.</exception>
    public void Start()
    {
        foreach (var port in _plan.Port.Candidates())
        {
            var listener = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };

            try
            {
                listener.Start();
            }
            catch (SocketException)
            {
                listener.Dispose();
                continue;
            }

            _listener = listener;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            _ = AcceptAsync(listener, _stopping.Token);
            return;
        }

        throw new SocksException($"no free loopback port in {_plan.Port} for the browser proxy");
    }

    private async Task AcceptAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;

            try
            {
                client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            }
            catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException or SocketException)
            {
                return;
            }

            _ = ServeAsync(client, ct);
        }
    }

    private async Task ServeAsync(TcpClient client, CancellationToken ct)
    {
        using var _ = client;
        client.NoDelay = true;
        var stream = client.GetStream();

        try
        {
            var target = await HandshakeAsync(client, stream, ct).ConfigureAwait(false);

            if (target is null)
            {
                return;
            }

            var route = Choose(target, _plan.Egress, _plan.Domain);
            var clock = Stopwatch.StartNew();
            var (upstream, refusal) = await DialAsync(target, route, ct).ConfigureAwait(false);

            if (upstream is null)
            {
                // A port the session is waiting on gets a page that says so
                // and waits too, instead of the browser's "can't connect".
                if (route == SocksRoute.Instance && target.IsLoopback && _expected?.Invoke(target.Port) is { } expected)
                {
                    _log.Debug($"browser: {target} is not up yet — answered with the loading page");
                    await Socks5.ReplyAsync(stream, SocksReply.Succeeded, ct).ConfigureAwait(false);
                    await LoadingPage.ServeAsync(stream, expected, ct).ConfigureAwait(false);
                    return;
                }

                _log.Debug($"browser: {target} ({Describe(route)}) — {Explain(refusal)}");
                await Socks5.ReplyAsync(stream, refusal, ct).ConfigureAwait(false);
                return;
            }

            await using (upstream.ConfigureAwait(false))
            {
                _log.Debug(string.Create(CultureInfo.InvariantCulture,
                    $"browser: {target} ({Describe(route)}) in {clock.ElapsedMilliseconds} ms"));

                await Socks5.ReplyAsync(stream, SocksReply.Succeeded, ct).ConfigureAwait(false);
                await PumpAsync(stream, upstream, ct).ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is SocksException or IOException or SocketException or OperationCanceledException
                                      or ObjectDisposedException)
        {
            // A client that hung up, spoke something else, or was here when the
            // session ended. None of it is worth more than the connection.
        }
    }

    /// <summary>
    /// Greeting, authentication and request. Returns where to go, or null once
    /// the client has been refused.
    /// </summary>
    private async Task<SocksTarget?> HandshakeAsync(TcpClient client, NetworkStream stream, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(HandshakeTimeout);

        var methods = await Socks5.ReadGreetingAsync(stream, deadline.Token).ConfigureAwait(false);

        if (methods.Contains(Socks5.UsernamePassword))
        {
            await Socks5.SelectAsync(stream, Socks5.UsernamePassword, deadline.Token).ConfigureAwait(false);
            var (user, password) = await Socks5.ReadCredentialsAsync(stream, deadline.Token).ConfigureAwait(false);
            var accepted = Socks5.Matches(user, password, _plan.User, _plan.Password);
            await Socks5.AnswerCredentialsAsync(stream, accepted, deadline.Token).ConfigureAwait(false);

            if (!accepted)
            {
                _log.Warn($"browser: refused a connection with the wrong credentials for '{user}'");
                return null;
            }
        }
        else if (methods.Contains(Socks5.NoAuthentication) && await IsLaunchedBrowserAsync(client, deadline.Token).ConfigureAwait(false))
        {
            await Socks5.SelectAsync(stream, Socks5.NoAuthentication, deadline.Token).ConfigureAwait(false);
        }
        else
        {
            await Socks5.SelectAsync(stream, Socks5.NoAcceptableMethods, deadline.Token).ConfigureAwait(false);
            return null;
        }

        var (target, refusal) = await Socks5.ReadRequestAsync(stream, deadline.Token).ConfigureAwait(false);

        if (target is null)
        {
            await Socks5.ReplyAsync(stream, refusal, deadline.Token).ConfigureAwait(false);
        }

        return target;
    }

    /// <summary>Whether the process on the other end is one of this session's browsers, saying so once if not.</summary>
    private async Task<bool> IsLaunchedBrowserAsync(TcpClient client, CancellationToken ct)
    {
        if (client.Client.RemoteEndPoint is not IPEndPoint remote ||
            await ConnectionOwner.FindAsync(remote, Port, ct).ConfigureAwait(false) is not { } pid)
        {
            WarnOnce(0, "browser: refused a connection with no password whose process could not be identified");
            return false;
        }

        if (await _launched.ContainsAsync(pid, ct).ConfigureAwait(false))
        {
            return true;
        }

        WarnOnce(pid, string.Create(CultureInfo.InvariantCulture,
            $"browser: refused {ConnectionOwner.Name(pid)} (pid {pid}) — no password, and not a browser this " +
            $"session opened. Use the proxy URL with its credentials (/status prints it)."));

        return false;
    }

    private void WarnOnce(int pid, string message)
    {
        lock (_refused)
        {
            if (!_refused.Add(pid))
            {
                return;
            }
        }

        _log.Warn(message);
    }

    private async Task<(Stream? Upstream, SocksReply Refusal)> DialAsync(
        SocksTarget target, SocksRoute route, CancellationToken ct)
    {
        if (route == SocksRoute.Instance)
        {
            IReadOnlyList<string> hosts = target.IsLoopback ? target.LoopbackCandidates : [target.Host];
            var relay = await _dialInstance(hosts, target.Port, ct).ConfigureAwait(false);

            // The relay cannot tell refused from unreachable without a way to
            // say which, and a browser shows both as "can't connect". Refused is
            // the likelier truth for a loopback port: nothing is listening yet.
            return (relay, SocksReply.ConnectionRefused);
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(LocalDialTimeout);
        var socket = new TcpClient { NoDelay = true };

        try
        {
            await socket.ConnectAsync(target.Host, target.Port, deadline.Token).ConfigureAwait(false);
            return (new NetworkStream(socket.Client, ownsSocket: true), SocksReply.Succeeded);
        }
        catch (SocketException e)
        {
            socket.Dispose();
            return (null, Socks5.ReplyFor(e));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            socket.Dispose();
            return (null, SocksReply.HostUnreachable);
        }
    }

    /// <summary>
    /// Copy both ways until either side ends, then end both.
    /// </summary>
    /// <remarks>
    /// Not a half-close each way. A browser never half-closes, and a relay in
    /// the instance cannot pass a half-close on anyway — so waiting for the
    /// second direction would only hold a socket open that nobody will write to.
    /// </remarks>
    private static async Task PumpAsync(Stream client, Stream upstream, CancellationToken ct)
    {
        using var either = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var up = client.CopyToAsync(upstream, either.Token);
        var down = upstream.CopyToAsync(client, either.Token);

        await Task.WhenAny(up, down).ConfigureAwait(false);
        await either.CancelAsync().ConfigureAwait(false);

        try
        {
            await Task.WhenAll(up, down).ConfigureAwait(false);
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or SocketException
                                      or ObjectDisposedException)
        {
            // The side that did not finish, cancelled.
        }
    }

    private static string Describe(SocksRoute route) => route == SocksRoute.Instance ? "in the instance" : "from here";

    private static string Explain(SocksReply refusal) => refusal switch
    {
        SocksReply.ConnectionRefused => "nothing is listening",
        SocksReply.HostUnreachable => "unreachable",
        _ => "failed",
    };

    public async ValueTask DisposeAsync()
    {
        await _stopping.CancelAsync().ConfigureAwait(false);
        _listener?.Stop();
        _listener?.Dispose();
        _stopping.Dispose();
    }
}
