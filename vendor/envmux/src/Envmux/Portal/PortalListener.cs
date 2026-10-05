using System.Globalization;
using System.Net;

using Envmux.Agents;
using Envmux.Config;
using Envmux.Routing;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Envmux.Portal;

/// <summary>
/// The listener, and the one port range envmux still claims.
/// </summary>
/// <remarks>
/// <para>
/// It serves the portal on loopback, and — when the session has an instance to
/// talk to — the chat API on the one address the Incus host can reach. What
/// used to be here was a reverse proxy: every route arrived on this port, was
/// matched by <c>Host</c>, and was forwarded to whatever loopback port Docker
/// had published for it. All of that existed to undo the flattening of every
/// environment onto one host port space, and there is no flattening left — a
/// route is a port on the instance's own address, reached directly, with
/// nothing in the path.
/// </para>
/// <para>
/// <b>Kestrel's bind is the claim.</b> The port is not probed and then taken —
/// probing and binding separately leaves a window for another process to get in
/// between. Kestrel is asked for the preferred port; if that throws, it is asked
/// for the next one, and the listener it ends up holding is the claim for the
/// life of the process.
/// </para>
/// <para>
/// <b>Two endpoints, two applications.</b> The bridge is a second
/// <see cref="WebApplication"/> rather than a second <c>Listen</c> on the
/// first, because the two differ in what they serve and how they gate it, and
/// Kestrel's middleware is per application rather than per endpoint. Keeping
/// them apart is what lets the bridge's pipeline contain the chat API and a
/// 404 and nothing else — not a check that the page is off, but no page.
/// </para>
/// </remarks>
internal sealed class PortalListener(Session.Session session) : IAsyncDisposable
{
    private WebApplication? _app;
    private WebApplication? _bridge;
    private RoomFeed? _room;
    private PortalHost? _host;

    /// <summary>The loopback port it actually claimed.</summary>
    public int Port { get; private set; }

    /// <summary>Where the bridge answers, or null when there is none.</summary>
    public IPEndPoint? Bridge { get; private set; }

    /// <summary>
    /// Claim a port and start serving, walking upward when one is taken.
    /// </summary>
    /// <param name="spec">The port to prefer, or the range to claim within.</param>
    /// <param name="bridge">
    /// The address to serve the chat API on for the instance, or null for no
    /// bridge. Its port is walked upward from the loopback one, within the same
    /// range: the same number when it is free there, which it nearly always is,
    /// because a different address is a different socket.
    /// </param>
    /// <param name="ct">Cancellation.</param>
    /// <exception cref="IOException">Every candidate port was taken.</exception>
    public async Task StartAsync(PortSpec spec, IPAddress? bridge = null, CancellationToken ct = default)
    {
        _room ??= new RoomFeed(session.Plan.Directory);
        var host = _host ??= new PortalHost(session, _room);

        foreach (var port in spec.Candidates())
        {
            try
            {
                _app = Build(host, port);
                await _app.StartAsync(ct).ConfigureAwait(false);
                Port = port;
                break;
            }
            catch (IOException)
            {
                // Taken between the last session starting and this one. Try the
                // next; the message when they are all gone is below.
                if (_app is not null)
                {
                    await _app.DisposeAsync().ConfigureAwait(false);
                    _app = null;
                }
            }
        }

        if (_app is null)
        {
            throw new IOException(
                $"no free port in {spec} for the portal. Another session may already have the range, " +
                "or something else on this machine has.");
        }

        if (bridge is null)
        {
            return;
        }

        foreach (var port in spec.Candidates().Where(p => p >= Port))
        {
            try
            {
                _bridge = BuildBridge(host, bridge, port);
                await _bridge.StartAsync(ct).ConfigureAwait(false);
                Bridge = new IPEndPoint(bridge, port);
                return;
            }
            catch (IOException)
            {
                if (_bridge is not null)
                {
                    await _bridge.DisposeAsync().ConfigureAwait(false);
                    _bridge = null;
                }
            }
        }

        // Not fatal: the portal is up, and the session works without the room.
        // The session says so — see Session.WireRoomAsync — because it knows
        // whether anything wanted the room in the first place.
    }

    private static WebApplication Build(PortalHost host, int port)
    {
        var builder = WebApplication.CreateSlimBuilder();

        // Loopback only, and not negotiable from configuration. The portal can
        // open a shell in the instance, so the set of machines that may reach it
        // is exactly one.
        builder.WebHost.ConfigureKestrel(options =>
            options.Listen(IPAddress.Loopback, port));

        // The framework's own logging would write request lines into a terminal
        // this process is drawing a window in. Everything worth saying goes
        // through the session log instead.
        builder.Logging.ClearProviders();

        var app = builder.Build();

        // Before the gate, because a websocket has to be recognised as one
        // before anything decides what to do with it. Without this,
        // `context.WebSockets.IsWebSocketRequest` is false for every request —
        // the upgrade headers are simply never inspected — and the portal's
        // terminal answers "a shell is a websocket" to a request that was one.
        // It had never worked.
        app.UseWebSockets();

        app.Use(host.GateAsync);
        host.Map(app);

        // The explicit pattern, not the default. MapFallback's own is
        // `{*path:nonfile}`, which declines any path whose last segment looks
        // like a filename — a sensible default when static files are on disk in
        // front of it, and wrong here, where the page's own assets are inside
        // the binary and this is the only thing that serves them. With the
        // default, every script and stylesheet the page asks for 404s, which is
        // a blank tab and a console full of MIME errors and nothing in the log.
        app.MapFallback("{*path}", PortalHost.PageAsync);

        return app;
    }

    /// <summary>
    /// The bridge: the chat API on the address the Incus host reaches, and nothing else.
    /// </summary>
    /// <remarks>
    /// The one interface that faces the host's switch — never <c>0.0.0.0</c>,
    /// since this listener takes the credential the workstation signs into the
    /// session with. What it serves is decided in <see cref="PortalHost.BridgeGateAsync"/>
    /// and <see cref="PortalHost.MapBridge"/>: the room, behind the bearer, and a
    /// 404 for every other path before any credential is looked at.
    /// </remarks>
    private static WebApplication BuildBridge(PortalHost host, IPAddress address, int port)
    {
        var builder = WebApplication.CreateSlimBuilder();

        builder.WebHost.ConfigureKestrel(options => options.Listen(address, port));
        builder.Logging.ClearProviders();

        var app = builder.Build();

        app.UseWebSockets();
        app.Use(host.BridgeGateAsync);
        host.MapBridge(app);

        return app;
    }

    /// <summary>What this is, for a plan or a log line.</summary>
    public string Describe() =>
        $"{RouteListing.PortalName} on {PortalPlan.Loopback}:{Port.ToString(CultureInfo.InvariantCulture)}";

    public async ValueTask DisposeAsync()
    {
        await StopAsync(_bridge).ConfigureAwait(false);
        _bridge = null;
        Bridge = null;

        await StopAsync(_app).ConfigureAwait(false);
        _app = null;

        _room?.Dispose();
        _room = null;
        _host?.Dispose();
        _host = null;
    }

    private static async Task StopAsync(WebApplication? app)
    {
        if (app is null)
        {
            return;
        }

        try
        {
            // Bounded, because quitting is already several seconds of teardown
            // and a listener with a websocket still open would otherwise hold
            // the whole exit behind it.
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await app.StopAsync(deadline.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException)
        {
            // The process is ending; the socket goes with it.
        }

        await app.DisposeAsync().ConfigureAwait(false);
    }
}
