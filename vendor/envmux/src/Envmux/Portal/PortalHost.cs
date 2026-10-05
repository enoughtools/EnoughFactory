using System.Globalization;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Envmux.Agents;
using Envmux.Editor;
using Envmux.Incus;
using Envmux.Session;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;

namespace Envmux.Portal;

/// <summary>
/// The session as a page, and as an API.
/// </summary>
/// <remarks>
/// <para>
/// What it serves is the built page out of <see cref="PortalAssets"/> and a
/// small API over the one <see cref="Session"/> this process is — the same
/// object the terminal window is drawn from, so the two can never disagree
/// about what a task is doing.
/// </para>
/// <para>
/// Two listeners share it, and they are not the same thing. The portal proper
/// is on loopback, scoped to the hostnames it answers on, and takes the token
/// from the query once and a cookie thereafter. The <em>bridge</em> listener
/// (<see cref="ApiBridge"/>) faces the Incus host, serves the chat API and
/// nothing else, and takes the token as a bearer and nothing else — no cookie,
/// no query, no page. Guests get a separate chat bearer; an opted-in chef gets
/// another bearer for repository-scoped dispatch. Neither authorizes browser control.
/// </para>
/// </remarks>
internal sealed class PortalHost(Session.Session session, RoomFeed room) : IDisposable
{
    private readonly SemaphoreSlim _dispatch = new(1, 1);

    public void Dispose() => _dispatch.Dispose();
    /// <summary>
    /// The cookie the token is exchanged for.
    /// </summary>
    /// <remarks>
    /// So the token appears in the address bar once and not in every request a
    /// page makes afterwards — and so that a websocket, which cannot be given
    /// headers by the browser, is authorised by the same thing everything else
    /// is.
    /// </remarks>
    private const string CookieName = "envmux-portal";

    /// <summary>The query parameter the URL carries the token in.</summary>
    private const string TokenParameter = "k";

    /// <summary>How often a live page is sent the session again, at most.</summary>
    /// <remarks>
    /// The window redraws on a 20ms tick; this is an order of magnitude slower
    /// because it is a serialised snapshot over a socket rather than a diff
    /// against a screen, and four a second is already faster than anything a
    /// person reads.
    /// </remarks>
    private static readonly TimeSpan PushInterval = TimeSpan.FromMilliseconds(250);

    /// <summary>How long a quiet stream waits before saying something anyway.</summary>
    /// <remarks>
    /// A comment line, which the EventSource specification requires be ignored.
    /// It exists so that a connection dropped by something in between is
    /// discovered by the browser — which reconnects on its own — rather than
    /// left looking like a session that has stopped changing.
    /// </remarks>
    private static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(15);

    /// <summary>What the terminal in the browser says it is.</summary>
    private static readonly Dictionary<string, string> ShellEnvironment = new(StringComparer.Ordinal)
    {
        ["TERM"] = "xterm-256color",
        ["COLORTERM"] = "truecolor",
    };

    private PortalPlan Plan => session.Plan.Portal;

    /// <summary>
    /// The hostnames it answers on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only the loopback ones now, because only loopback reaches this listener.
    /// The session's own name used to be here too — routes and the page arrived
    /// on the same port and had to be told apart by <c>Host</c> — and there is
    /// nothing left to tell apart: a route is a port on the instance's own
    /// address, and never comes here at all.
    /// </para>
    /// <para>
    /// No <c>[::1]</c>. The listener is bound to the IPv4 loopback, so nothing
    /// arrives over IPv6 to be matched — and routing's host matcher refuses to
    /// parse a bracketed literal at all, which it does by throwing on the first
    /// request rather than when the route is declared.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<string> Hostnames => [PortalPlan.Loopback, "localhost"];

    /// <summary>Whether a request arriving with this <c>Host</c> is the portal's.</summary>
    public static bool Serves(HostString host) =>
        host.HasValue && Hostnames.Contains(host.Host, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Let a request through, or refuse it — before routing chooses an endpoint.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One gate in front of everything rather than a check inside each handler,
    /// because a handler that forgets the check is a shell in your instance
    /// handed to whatever else is running on this machine.
    /// </para>
    /// <para>
    /// A <c>Host</c> this listener does not serve is refused outright. It used
    /// to be passed through, because routed hostnames arrived here too and were
    /// the proxy's; nothing else arrives here now, so a request naming some
    /// other host is a browser that resolved an attacker's name to 127.0.0.1 —
    /// which is the whole of the DNS rebinding attack, and checking the header
    /// is the whole of the defence.
    /// </para>
    /// <para>
    /// A token in the query is exchanged for a cookie and then taken out of the
    /// address bar, so that the secret is not in the URL of every page anybody
    /// screenshots afterwards.
    /// </para>
    /// <para>
    /// The same token as a bearer is accepted too, for a client that is a
    /// program rather than a tab: nothing to redirect, no cookie jar, and the
    /// secret in a header rather than a URL that ends up in a shell history.
    /// </para>
    /// </remarks>
    public async Task GateAsync(HttpContext context, RequestDelegate next)
    {
        if (!Serves(context.Request.Host))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        if (!Plan.WantsToken)
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        if (Matches(context.Request.Cookies[CookieName]) || Matches(Bearer(context.Request)))
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        if (!Matches(context.Request.Query[TokenParameter]))
        {
            await RefuseAsync(context).ConfigureAwait(false);
            return;
        }

        context.Response.Cookies.Append(CookieName, Plan.Token, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Path = "/",

            // Not Secure: this is plain HTTP on loopback, and a Secure cookie
            // would simply never be sent back.
            IsEssential = true,
        });

        // Only the page itself is redirected. An API call made with the token on
        // it — which is how the first request of a fresh tab can arrive — is
        // answered rather than bounced.
        if (HttpMethods.IsGet(context.Request.Method) &&
            !context.Request.Path.StartsWithSegments("/api", StringComparison.Ordinal))
        {
            context.Response.Redirect(Without(context.Request));
            return;
        }

        await next(context).ConfigureAwait(false);
    }

    /// <summary>
    /// Let a request through the bridge, or refuse it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The bridge faces the Incus host, so a request here may come from any
    /// instance on that bridge — through the proxy device or not, indistinguishably
    /// (see <see cref="ApiBridge"/>). What it may reach is the chat API and
    /// nothing else: a path that is not the room is a 404 before anything looks
    /// at credentials, so that the shell, the tasks and the page are not merely
    /// locked on this door but absent from it.
    /// </para>
    /// <para>
    /// Authorisation is the bearer and only the bearer. No cookie, because no
    /// browser is meant to be here and a cookie is an ambient credential a page
    /// on some other origin could ride; no query, because the token would then
    /// be in a URL a guest's shell history keeps.
    /// </para>
    /// <para>
    /// No <c>Host</c> check, and deliberately not by loosening the loopback
    /// one. A request through the proxy device carries the <c>Host</c> the guest
    /// dialled — <c>127.0.0.1:8078</c>, which happens to name loopback — and one
    /// made directly to the bridge address carries that address; neither says
    /// anything about who is asking. The header defends the loopback listener
    /// against DNS rebinding, which is an attack on a browser's ambient
    /// credentials, and this listener has none: refuse the bearer, and there is
    /// nothing a rebound name could borrow.
    /// </para>
    /// </remarks>
    public async Task BridgeGateAsync(HttpContext context, RequestDelegate next)
    {
        if (context.Request.Path.StartsWithSegments("/api/kitchen", StringComparison.Ordinal))
        {
            var supplied = Bearer(context.Request);
            if (!session.Plan.Chef || supplied is null ||
                !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(session.ChefToken)))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await next(context).ConfigureAwait(false);
            return;
        }

        if (!IsChat(context.Request.Path))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var roomBearer = Bearer(context.Request);
        if (!Plan.WantsToken || roomBearer is null || !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(roomBearer), Encoding.UTF8.GetBytes(Plan.RoomToken)))
        {
            await ProblemAsync(context, StatusCodes.Status401Unauthorized, "the room wants its guest token, as a bearer")
                .ConfigureAwait(false);
            return;
        }

        await next(context).ConfigureAwait(false);
    }

    /// <summary>Whether a path is the chat API — <c>/api/chat</c> or something under it.</summary>
    private static bool IsChat(PathString path) =>
        path.StartsWithSegments("/api/chat", StringComparison.Ordinal);

    /// <summary>The bearer token on a request, or null when there is none.</summary>
    private static string? Bearer(HttpRequest request) =>
        AuthenticationHeaderValue.TryParse(request.Headers.Authorization, out var header) &&
        header.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase)
            ? header.Parameter
            : null;

    /// <summary>Map the API. The page itself is the router's fallback.</summary>
    public void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireHost([.. Hostnames]);

        api.MapGet("/state", (HttpContext context) => JsonAsync(context, PortalState.Of(session).ToJson()));
        api.MapGet("/events", EventsAsync);
        api.MapGet("/tasks/{name}/output", OutputAsync);
        api.MapGet("/tasks/{name}/log", LogAsync);
        api.MapPost("/tasks/{name}/{action}", TaskAsync);
        api.MapPost("/restart", RestartAsync);
        api.MapPost("/stop", StopAsync);
        api.MapPost("/editor", EditorAsync);
        api.MapPost("/browser", BrowserAsync);
        api.MapGet("/shell", ShellAsync);
        api.MapGet("/repository/status", RepositoryStatusAsync);
        api.MapGet("/repository/diff", RepositoryDiffAsync);

        // The control plane for remote agents. The same files `envmux agent`
        // reads and writes, so the command line and this page agree without a
        // word passing between them.
        api.MapGet("/agents", AgentsAsync);
        api.MapPost("/agents", StartAgentAsync);
        api.MapPost("/agents/{name}/stop", StopAgentAsync);
        api.MapGet("/agents/{name}/log", AgentLogAsync);
        MapChat(api);
    }

    /// <summary>
    /// Map what the bridge serves: the room, and a 404 for everything else.
    /// </summary>
    /// <remarks>
    /// No <c>RequireHost</c>: the loopback group's is there to keep the API off
    /// hostnames it does not serve, and this listener has no hostnames — see
    /// <see cref="BridgeGateAsync"/> for what stands in its place.
    /// </remarks>
    public void MapBridge(WebApplication app)
    {
        MapChat(app.MapGroup("/api"));
        var kitchen = app.MapGroup("/api/kitchen");
        kitchen.MapGet("/agents", (HttpContext context) => JsonAsync(context,
            WireJson.Serialize(WireJson.Object(AgentRegistry.Json, ("agents", AgentRegistry.List(session.Plan.Directory))), AgentRegistry.Json)));
        kitchen.MapPost("/agents", DispatchAsync);
        kitchen.MapPost("/agents/{name}/stop", StopAgentAsync);
        kitchen.MapGet("/agents/{name}/log", AgentLogAsync);
        app.MapFallback("{*path}", (HttpContext context) =>
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return Task.CompletedTask;
        });
    }

    private void MapChat(IEndpointRouteBuilder api)
    {
        api.MapGet("/chat", ChatAsync);
        api.MapPost("/chat", SayAsync);
        api.MapGet("/chat/ws", ChatSocketAsync);
    }

    /// <summary>What the browser sends to start an agent, or to speak.</summary>
    internal sealed record AgentRequest(string? Name, string? Prompt, string? Nick, string? To, string? Text);

    private async Task DispatchAsync(HttpContext context)
    {
        await _dispatch.WaitAsync(context.RequestAborted).ConfigureAwait(false);
        try
        {
            if (AgentRegistry.List(session.Plan.Directory).Count(a => a.IsActive) >= 3)
            {
                await ProblemAsync(context, StatusCodes.Status409Conflict, "the kitchen already has three active workers; wait or stop one")
                    .ConfigureAwait(false);
                return;
            }

            await StartAgentAsync(context).ConfigureAwait(false);
        }
        finally
        {
            _dispatch.Release();
        }
    }

    /// <summary>
    /// Every remote agent this repository has, and where each is.
    /// </summary>
    /// <remarks>
    /// Read from the registry on every call rather than kept on the session,
    /// because the registry is shared with every other envmux on this machine —
    /// an agent started from a terminal is listed here a moment later with no
    /// channel between the two processes but the directory.
    /// </remarks>
    private Task AgentsAsync(HttpContext context) =>
        JsonAsync(context, WireJson.Serialize(WireJson.Object(AgentRegistry.Json,
            ("room", Agents.Chatroom.Room(session.Plan.Project)),
            ("directory", Agents.AgentRegistry.Directory),
            ("agents", Agents.AgentRegistry.List(session.Plan.Directory))), Agents.AgentRegistry.Json));

    /// <summary>
    /// Start a remote agent from the page: a task, a name, and this session's repository.
    /// </summary>
    /// <remarks>
    /// The one thing on this page that starts a process on the workstation.
    /// It is the same spawn the command line does, and the agent it starts is
    /// as independent of this session as one started from a terminal — this
    /// session ending does not end it.
    /// </remarks>
    private async Task StartAgentAsync(HttpContext context)
    {
        var asked = await ReadAsync<AgentRequest>(context).ConfigureAwait(false);

        if (asked is not { Name.Length: > 0, Prompt.Length: > 0 })
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, "an agent needs a name and a prompt").ConfigureAwait(false);
            return;
        }

        var nick = asked.Nick is { Length: > 0 } given && Agents.Chatroom.IsNick(given) ? given : Agents.Chatroom.DefaultNick;

        try
        {
            var plan = SessionPlan.Resolve(Config.SessionConfig.Load(session.Plan.Directory), session.Plan.Directory, asked.Name)
                with
            { Backend = session.Plan.Backend, Chef = false };
            if (string.Equals(plan.Session, session.Plan.Session, StringComparison.Ordinal))
            {
                throw new AgentException("a worker cannot use the controlling session's name; choose another name");
            }
            var kitchen = context.Request.Path.StartsWithSegments("/api/kitchen", StringComparison.Ordinal);
            var record = Agents.AgentRegistry.Start(session.Plan.Directory, plan, asked.Prompt,
                kitchen ? "chef" : nick, maximumActive: kitchen ? 3 : null);

            await Agents.Chatroom.AppendAsync(
                session.Plan.Directory,
                Agents.Chatroom.Event(DateTime.Now, nick, $"started {record.Nick} on {record.Branch} — {record.Summary}"),
                DateTime.Now,
                context.RequestAborted).ConfigureAwait(false);

            session.Log.Info($"portal: started remote agent '{record.Name}' on {record.Branch}");

            context.Response.StatusCode = StatusCodes.Status201Created;
            await JsonAsync(context, WireJson.Serialize(record, Agents.AgentRegistry.Json)).ConfigureAwait(false);
        }
        catch (Exception e) when (e is Agents.AgentException or Config.ConfigException)
        {
            await ProblemAsync(context, StatusCodes.Status409Conflict, e.Message).ConfigureAwait(false);
        }
    }

    private async Task StopAgentAsync(HttpContext context, string name)
    {
        var wanted = Config.Slug.From(name);

        if (Agents.AgentRegistry.Load(session.Plan.Directory, wanted) is null)
        {
            await ProblemAsync(context, StatusCodes.Status404NotFound, $"no agent called '{wanted}'").ConfigureAwait(false);
            return;
        }

        Agents.AgentRegistry.RequestStop(session.Plan.Directory, wanted);
        session.Log.Info($"portal: asked remote agent '{wanted}' to stop");
        context.Response.StatusCode = StatusCodes.Status202Accepted;
    }

    /// <summary>An agent's session log — what its headless run would have printed. Its transcript is `envmux logs`.</summary>
    private async Task AgentLogAsync(HttpContext context, string name)
    {
        var path = Agents.AgentRegistry.LogPath(session.Plan.Directory, Config.Slug.From(name));

        if (!File.Exists(path))
        {
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return;
        }

        context.Response.ContentType = "text/plain; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";

        // Shared for writing: the agent's process has this file open for append.
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        await stream.CopyToAsync(context.Response.Body, context.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>
    /// The room: the recent hour, or — with <c>after=</c> — everything since a cursor, waited for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two questions on one path, told apart by the cursor. Without one this is
    /// the page's opening read: the last four quarter hours parsed, the names in
    /// the room, and the cursor at the end, which is what a follower asks with
    /// next. With one it is the long poll — the physical lines after that place,
    /// held for up to <c>wait</c> seconds until there are any, and the cursor to
    /// ask with after that. A follower that keeps asking with what it was last
    /// handed sees every line exactly once, across the quarter-hour rollover and
    /// across a day's.
    /// </para>
    /// <para>
    /// <c>Accept: text/plain</c> asks for <see cref="RoomWire"/>'s form instead
    /// of JSON, for the client in the instance that has <c>curl</c> and a shell.
    /// The recent read in that form is the whole of those buckets as physical
    /// lines, which is what a client that is about to mirror them wants.
    /// </para>
    /// </remarks>
    private async Task ChatAsync(HttpContext context, int? buckets, string? after, int? wait)
    {
        var text = WantsText(context.Request);

        if (after is null)
        {
            var recent = room.Recent(buckets is > 0 and <= 96 ? buckets.Value : Chatroom.RecentBuckets);

            if (text)
            {
                await TextAsync(context, recent).ConfigureAwait(false);
                return;
            }

            await JsonAsync(context, WireJson.Serialize(WireJson.Object(AgentRegistry.Json,
                ("room", Chatroom.Room(session.Plan.Project)),
                ("path", Chatroom.RoomDirectory),
                ("names", Chatroom.Names(session.Plan.Directory)),
                ("lines", Chatroom.ParseAll(recent.Entries.Select(e => e.Raw))),
                ("cursor", recent.Cursor.ToString())), AgentRegistry.Json)).ConfigureAwait(false);

            return;
        }

        if (!RoomCursor.TryParse(after, out var cursor))
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest,
                $"'{after}' is not a cursor — the API hands one back as `cursor`, like 2026-09-03/1115.txt:12").ConfigureAwait(false);
            return;
        }

        RoomDelta delta;

        try
        {
            delta = await room.WaitAsync(cursor, TimeSpan.FromSeconds(Math.Clamp(wait ?? 0, 0, (int)RoomFeed.MaxWait.TotalSeconds)),
                context.RequestAborted).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // The client gave up waiting. Nothing to answer, and nobody to answer.
            return;
        }

        if (text)
        {
            await TextAsync(context, delta).ConfigureAwait(false);
            return;
        }

        await JsonAsync(context, Delta(delta)).ConfigureAwait(false);
    }

    /// <summary>
    /// One line into the room — or, from the client in the instance, lines that already carry their stamps.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The page and the command line send JSON — text, a nick, an addressee —
    /// and the line is stamped and filed here, as whoever they say they are, the
    /// chef by default. The guest sends <see cref="RoomWire"/> text: lines other
    /// agents already wrote, each with the bucket it was written into, carried
    /// as they are, because a room line with a rewritten timestamp is a line
    /// that says the wrong time.
    /// </para>
    /// <para>
    /// The guest also says where it was (<c>after=</c>) and is answered with
    /// what landed since, minus what it just sent, and the cursor past it all —
    /// see <see cref="RoomFeed.AppendAsync(RoomCursor, IReadOnlyList{RoomEntry}, CancellationToken)"/>
    /// for why that is the shape that makes a one-loop client correct.
    /// </para>
    /// </remarks>
    private async Task SayAsync(HttpContext context, string? after)
    {
        if (context.Request.ContentType is { } type &&
            type.StartsWith("text/plain", StringComparison.OrdinalIgnoreCase))
        {
            await AppendRawAsync(context, after).ConfigureAwait(false);
            return;
        }

        var asked = await ReadAsync<AgentRequest>(context).ConfigureAwait(false);

        if (asked is not { Text.Length: > 0 })
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, "nothing to say").ConfigureAwait(false);
            return;
        }

        if (Compose(asked) is not { } line)
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, $"'{asked.To}' is not a name the room accepts").ConfigureAwait(false);
            return;
        }

        var delta = await room.AppendAsync(line, DateTime.Now, context.RequestAborted).ConfigureAwait(false);

        context.Response.StatusCode = StatusCodes.Status201Created;
        await JsonAsync(context, WireJson.Serialize(WireJson.Object(AgentRegistry.Json, ("line", line), ("cursor", delta.Cursor.ToString())), AgentRegistry.Json))
            .ConfigureAwait(false);
    }

    /// <summary>A room line from what the page or the command line asked to say, or null when the addressee is not a nick.</summary>
    private static string? Compose(AgentRequest asked)
    {
        var nick = asked.Nick is { Length: > 0 } given && Chatroom.IsNick(given) ? given : Chatroom.DefaultNick;

        if (asked.To is { Length: > 0 } to && !Chatroom.IsNick(to))
        {
            return null;
        }

        var now = DateTime.Now;

        return asked.To is { Length: > 0 } addressed
            ? Chatroom.SayTo(now, nick, addressed, asked.Text!)
            : Chatroom.Say(now, nick, asked.Text!);
    }

    /// <summary>Lines in the wire form, appended to the buckets they name.</summary>
    private async Task AppendRawAsync(HttpContext context, string? after)
    {
        if (!RoomCursor.TryParse(after, out var cursor))
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, $"'{after}' is not a cursor").ConfigureAwait(false);
            return;
        }

        string body;

        using (var reader = new StreamReader(context.Request.Body, Encoding.UTF8))
        {
            body = await reader.ReadToEndAsync(context.RequestAborted).ConfigureAwait(false);
        }

        IReadOnlyList<RoomEntry> entries;

        try
        {
            entries = RoomWire.Parse(body);
        }
        catch (FormatException e)
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, e.Message).ConfigureAwait(false);
            return;
        }

        // Without a cursor the caller is not following, so it is handed only
        // where the end now is: Between(end, end) is nothing, which is right.
        if (cursor.IsStart && entries.Count > 0)
        {
            cursor = room.End();
        }

        var delta = await room.AppendAsync(cursor, entries, context.RequestAborted).ConfigureAwait(false);

        context.Response.StatusCode = StatusCodes.Status201Created;

        if (WantsText(context.Request))
        {
            await TextAsync(context, delta).ConfigureAwait(false);
            return;
        }

        await JsonAsync(context, Delta(delta)).ConfigureAwait(false);
    }

    /// <summary>
    /// The room as a socket: every line pushed as it lands, and lines taken to append.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For the page and for anything else that can hold a socket open. Opened
    /// with the cursor the opening read handed back, so nothing said between
    /// that read and this connection is missed; each message is one physical
    /// line in the same shape the long poll uses, and the last one's cursor is
    /// where to reconnect from if the socket drops.
    /// </para>
    /// <para>
    /// Inbound messages are what <c>POST /api/chat</c> takes as JSON — text, a
    /// nick, an addressee — so a page that has the socket open need not open a
    /// second connection to speak. The guest in the instance does not use this:
    /// <c>curl</c> has no socket, and the long poll is what it has.
    /// </para>
    /// </remarks>
    private async Task ChatSocketAsync(HttpContext context, string? after)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, "the room's stream is a websocket").ConfigureAwait(false);
            return;
        }

        if (!RoomCursor.TryParse(after, out var cursor))
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, $"'{after}' is not a cursor").ConfigureAwait(false);
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);

        // No cursor means "from now": the page already read the recent room
        // and would not thank us for it again.
        if (cursor.IsStart)
        {
            cursor = room.End();
        }

        using var closed = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);

        var pushing = Task.Run(async () =>
        {
            try
            {
                while (!closed.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    var delta = await room.WaitAsync(cursor, RoomFeed.MaxWait, closed.Token).ConfigureAwait(false);

                    foreach (var entry in delta.Entries)
                    {
                        // Each line carries the cursor as it stands *after* it,
                        // so a client that reconnects from the last one it saw
                        // is handed the next.
                        cursor = cursor with { Bucket = entry.Bucket, Count = Advance(cursor, entry) };

                        var frame = WireJson.SerializeToUtf8Bytes(
                            WireJson.Object(AgentRegistry.Json, ("bucket", entry.Bucket), ("raw", entry.Raw), ("line", entry.Line), ("cursor", cursor.ToString())),
                            AgentRegistry.Json);

                        await socket.SendAsync(frame, WebSocketMessageType.Text, endOfMessage: true, closed.Token)
                            .ConfigureAwait(false);
                    }

                    cursor = delta.Cursor;
                }
            }
            catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException or IOException)
            {
                // The tab closed, or the socket went. Either ends the stream.
            }
        }, CancellationToken.None);

        var buffer = new byte[16 * 1024];

        try
        {
            while (socket.State == WebSocketState.Open && !closed.IsCancellationRequested)
            {
                var message = await ReceiveAsync(socket, buffer, closed.Token).ConfigureAwait(false);

                if (message is null)
                {
                    break;
                }

                AgentRequest? asked;

                try
                {
                    asked = WireJson.Deserialize<AgentRequest>(message, AgentRegistry.Json);
                }
                catch (JsonException)
                {
                    continue;
                }

                if (asked is { Text.Length: > 0 } && Compose(asked) is { } line)
                {
                    await room.AppendAsync(line, DateTime.Now, closed.Token).ConfigureAwait(false);
                }
            }
        }
        catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException or IOException)
        {
            // Same event, other direction.
        }
        finally
        {
            await closed.CancelAsync().ConfigureAwait(false);
            room.Signal();
            await pushing.ConfigureAwait(false);
            await PortalShell.CloseAsync(socket).ConfigureAwait(false);
        }
    }

    /// <summary>The count a cursor has after one more line of a bucket: one further into the same bucket, or the first of a new one.</summary>
    private static int Advance(RoomCursor cursor, RoomEntry entry) =>
        entry.Bucket.Equals(cursor.Bucket, StringComparison.Ordinal) ? cursor.Count + 1 : 1;

    /// <summary>One whole text message off a socket, or null when it closed.</summary>
    private static async Task<string?> ReceiveAsync(WebSocket socket, byte[] buffer, CancellationToken ct)
    {
        var message = new MemoryStream();

        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            message.Write(buffer, 0, result.Count);

            if (result.EndOfMessage)
            {
                return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            }
        }
    }

    /// <summary>Whether a request would rather have the wire form than JSON.</summary>
    private static bool WantsText(HttpRequest request) =>
        request.Headers.Accept.Any(a => a is not null && a.Contains("text/plain", StringComparison.OrdinalIgnoreCase));

    /// <summary>A delta in the wire form: the cursor in a header, the lines as the body.</summary>
    private static async Task TextAsync(HttpContext context, RoomDelta delta)
    {
        context.Response.ContentType = RoomWire.ContentType;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers[RoomWire.CursorHeader] = delta.Cursor.ToString();
        await context.Response.WriteAsync(RoomWire.Format(delta.Entries)).ConfigureAwait(false);
    }

    /// <summary>A delta as JSON: the cursor, and each physical line with its bucket and — when it is one — its parse.</summary>
    private static string Delta(RoomDelta delta) =>
        WireJson.Serialize(WireJson.Object(AgentRegistry.Json,
            ("cursor", delta.Cursor.ToString()),
            ("lines", delta.Entries.Select(e => WireJson.Object(AgentRegistry.Json,
                ("bucket", e.Bucket), ("raw", e.Raw), ("line", e.Line))))), AgentRegistry.Json);

    /// <summary>The request body as JSON, or null when it is not.</summary>
    private static async Task<T?> ReadAsync<T>(HttpContext context) where T : class
    {
        try
        {
            return await context.Request.ReadFromJsonAsync(WireJson.Info<T>(Agents.AgentRegistry.Json), context.RequestAborted)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>
    /// The page, for anything that is not the API.
    /// </summary>
    /// <remarks>
    /// A single-page app: a path that names a file is that file or a 404, and
    /// everything else is the page, which reads the path itself. Reached from
    /// the router's fallback, so it only ever runs for a request no route
    /// claimed.
    /// </remarks>
    public static async Task PageAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "/";

        if (PortalAssets.Find(path) is { } file)
        {
            await SendAsync(context, file).ConfigureAwait(false);
            return;
        }

        if (PortalAssets.Index is not { } index)
        {
            await NotBuiltAsync(context).ConfigureAwait(false);
            return;
        }

        // A missing asset is a missing asset. Answering it with the page would
        // hand a stale tab an HTML document where it asked for JavaScript, and
        // the error it then reports is about neither.
        if (Path.HasExtension(path))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        await SendAsync(context, index).ConfigureAwait(false);
    }

    private static async Task SendAsync(HttpContext context, PortalAsset asset)
    {
        context.Response.ContentType = asset.ContentType;

        // The hashed names may be cached until the heat death of the tab. The
        // page names them, so a cached copy of it is a cached copy of which
        // build you are running.
        context.Response.Headers.CacheControl = asset.Immutable
            ? "public, max-age=31536000, immutable"
            : "no-store";

        await context.Response.Body.WriteAsync(asset.Bytes).ConfigureAwait(false);
    }

    /// <summary>
    /// The session, pushed whenever it changes.
    /// </summary>
    /// <remarks>
    /// Server-sent events rather than a socket, because everything on this
    /// stream goes one way and the browser reconnects a dropped EventSource by
    /// itself. Changes set a flag and the loop sends at most one snapshot per
    /// tick, so a task writing a thousand lines a second is one push, not a
    /// thousand.
    /// </remarks>
    private async Task EventsAsync(HttpContext context)
    {
        var pending = 1;
        void Touch() => Interlocked.Exchange(ref pending, 1);
        void Logged(LogEntry entry) => Touch();

        session.Changed += Touch;
        session.Log.Appended += Logged;

        try
        {
            await StreamAsync(context, async write =>
            {
                var quiet = 0L;

                while (!context.RequestAborted.IsCancellationRequested)
                {
                    if (Interlocked.Exchange(ref pending, 0) == 1)
                    {
                        await write($"event: state\ndata: {PortalState.Of(session).ToJson()}\n\n").ConfigureAwait(false);
                        quiet = Environment.TickCount64;
                    }
                    else if (Environment.TickCount64 - quiet >= (long)Heartbeat.TotalMilliseconds)
                    {
                        await write(": still here\n\n").ConfigureAwait(false);
                        quiet = Environment.TickCount64;
                    }

                    await Task.Delay(PushInterval, context.RequestAborted).ConfigureAwait(false);
                }
            }).ConfigureAwait(false);
        }
        finally
        {
            session.Changed -= Touch;
            session.Log.Appended -= Logged;
        }
    }

    /// <summary>
    /// One task's output: everything it has said, and then everything it says.
    /// </summary>
    /// <remarks>
    /// Read-only by construction. This is the monitoring half of the portal —
    /// the tail you leave open on a dev server — and it is a different thing
    /// from a shell rather than a shell with the keyboard taken away: there is
    /// no pty, no exec, and nothing to type into.
    /// </remarks>
    private async Task OutputAsync(HttpContext context, string name)
    {
        if (session.FindTask(name) is not { } task)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var lines = System.Threading.Channels.Channel.CreateUnbounded<string>();
        void Arrived(string line) => lines.Writer.TryWrite(line);

        // Backlog and subscription together, so nothing is missed and nothing
        // arrives twice — see SessionTask.Follow.
        var backlog = task.Follow(Arrived);

        try
        {
            await StreamAsync(context, async write =>
            {
                foreach (var line in backlog)
                {
                    await write(Line(line)).ConfigureAwait(false);
                }

                await foreach (var line in lines.Reader.ReadAllAsync(context.RequestAborted).ConfigureAwait(false))
                {
                    await write(Line(line)).ConfigureAwait(false);
                }
            }).ConfigureAwait(false);
        }
        finally
        {
            task.Unfollow(Arrived);
            lines.Writer.TryComplete();
        }

        // A task's line is one line by construction — it came from a reader that
        // splits on newlines — so this cannot produce a multi-line data field.
        static string Line(string line) => $"data: {line}\n\n";
    }

    /// <summary>
    /// One task's whole log, read out of the instance rather than out of memory.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The other endpoint streams what envmux saw. This one is the file the task
    /// has been writing all along, whether or not anybody was watching — which
    /// is the point of latching a task rather than holding it: a build that ran
    /// while envmux was closed produced output, and this is how you read it.
    /// </para>
    /// <para>
    /// It replaces what <c>record-output</c> would have done, and differs from it
    /// in one way worth knowing: these logs do not expire on their own. Retention
    /// is envmux's problem, which is the right place for it, since envmux is what
    /// knows when a session ended.
    /// </para>
    /// </remarks>
    private async Task LogAsync(HttpContext context, string name)
    {
        if (session.FindTask(name) is not { LogPath.Length: > 0 } task)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        byte[]? contents;

        try
        {
            contents = await session.Backend.Files
                .PullAsync(session.Plan.InstanceName, task.LogPath, context.RequestAborted)
                .ConfigureAwait(false);
        }
        catch (Exception e) when (e is IncusException or SessionException)
        {
            await ProblemAsync(context, StatusCodes.Status502BadGateway, e.Message).ConfigureAwait(false);
            return;
        }

        if (contents is null)
        {
            // The task has not run yet, so there is no file. Not an error, and
            // not something to answer with a page.
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return;
        }

        context.Response.ContentType = "text/plain; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";

        // Named, so a browser saving it gets something that says which task and
        // which session it came from.
        context.Response.Headers.ContentDisposition =
            $"inline; filename=\"{Path.GetFileName(task.LogPath)}\"";

        await context.Response.Body.WriteAsync(contents, context.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>Start, stop or restart a task.</summary>
    private async Task TaskAsync(HttpContext context, string name, string action)
    {
        if (session.FindTask(name) is not { } task)
        {
            await ProblemAsync(context, StatusCodes.Status404NotFound, $"no task called '{name}'").ConfigureAwait(false);
            return;
        }

        // Not awaited to completion. Stopping a task signals it and waits out
        // its grace period, and a button that stays pressed for ten seconds is
        // a button people press again.
        switch (action)
        {
            case "start":
                Detach(task.StartAsync(CancellationToken.None), $"starting '{name}'");
                break;

            case "stop":
                Detach(task.StopAsync(CancellationToken.None), $"stopping '{name}'");
                break;

            case "restart":
                Detach(task.RestartAsync(CancellationToken.None), $"restarting '{name}'");
                break;

            default:
                await ProblemAsync(context, StatusCodes.Status400BadRequest,
                    $"'{action}' is not one of start, stop, restart").ConfigureAwait(false);
                return;
        }

        session.Log.Info($"portal: {action} '{name}'");
        context.Response.StatusCode = StatusCodes.Status202Accepted;
    }

    /// <summary>
    /// End the session, the way <c>q</c> does: commits back, port released,
    /// instance stopped or removed as the config says.
    /// </summary>
    /// <remarks>
    /// For a headless run, which has no window to quit and whose Ctrl-C has to
    /// come from a console a script may not own. Behind the token like every
    /// other action here. Answered before the teardown starts, because the
    /// teardown takes this listener with it.
    /// </remarks>
    private Task StopAsync(HttpContext context)
    {
        session.Log.Info("portal: stop");
        session.RequestStop();
        context.Response.StatusCode = StatusCodes.Status202Accepted;
        return Task.CompletedTask;
    }

    /// <summary>Recreate the container from the config as it is on disk now.</summary>
    private Task RestartAsync(HttpContext context)
    {
        session.Log.Info("portal: restart");
        Detach(session.RestartAsync(), "restarting the session");
        context.Response.StatusCode = StatusCodes.Status202Accepted;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Open a browser whose localhost is the instance — what the 'b' key does.
    /// </summary>
    /// <remarks>
    /// Like the editor, a thing that happens on this machine rather than in the
    /// instance. The page asking for it is itself in a browser that is not on
    /// the proxy, which is the point: this one is.
    /// </remarks>
    private async Task BrowserAsync(HttpContext context)
    {
        try
        {
            // ?open= is a route's name or URL, for the page's route links; absent,
            // browser.open or the first route, as the key does.
            var open = context.Request.Query["open"].ToString();
            var target = open.Length > 0 ? open : null;

            session.OpenBrowser(url: target);
            await JsonAsync(context, WireJson.Serialize(
                WireJson.Object(PortalState.Json, ("opened", true), ("url", target ?? session.BrowserStartUrl)), PortalState.Json)).ConfigureAwait(false);
        }
        catch (Socks.BrowserException e)
        {
            session.Log.Warn($"portal: browser: {e.Message}");
            await JsonAsync(context, WireJson.Serialize(
                WireJson.Object(PortalState.Json, ("opened", false), ("error", e.Message)), PortalState.Json)).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Attach an editor to the container — from the browser, on the host.
    /// </summary>
    /// <remarks>
    /// The one thing on this page that happens on the machine rather than in
    /// the container: the portal is a view of a process that is already running
    /// in front of somebody, and this asks that process to do what its 'e' key
    /// does. The URI comes back either way, because pasting it somewhere is a
    /// use of its own and the only one available when the editor is on another
    /// machine.
    /// </remarks>
    private async Task EditorAsync(HttpContext context)
    {
        if (session.EditorUri is not { } uri)
        {
            await ProblemAsync(context, StatusCodes.Status409Conflict,
                "there is no container to attach an editor to yet").ConfigureAwait(false);
            return;
        }

        try
        {
            await session.OpenInEditorAsync().ConfigureAwait(false);
            await JsonAsync(context, WireJson.Serialize(WireJson.Object(PortalState.Json, ("uri", uri), ("opened", true)), PortalState.Json))
                .ConfigureAwait(false);
        }
        catch (EditorException e)
        {
            session.Log.Warn($"portal: {e.Message}");
            await JsonAsync(context, WireJson.Serialize(
                WireJson.Object(PortalState.Json, ("uri", uri), ("opened", false), ("error", e.Message)), PortalState.Json)).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Read Git state in the live workspace, rather than the host branch that
    /// receives its commits only when the session stops.
    /// </summary>
    private async Task RepositoryStatusAsync(HttpContext context)
    {
        if (!await RepositoryAvailableAsync(context).ConfigureAwait(false))
        {
            return;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));

        try
        {
            var status = await RepositoryGitAsync(["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout.Token)
                .ConfigureAwait(false);
            var head = await RepositoryGitAsync(["rev-parse", "--verify", "HEAD"], timeout.Token).ConfigureAwait(false);
            var branch = await RepositoryGitAsync(["branch", "--show-current"], timeout.Token).ConfigureAwait(false);
            if (!status.Ok || !head.Ok || !branch.Ok)
            {
                await ProblemAsync(context, StatusCodes.Status422UnprocessableEntity,
                    (!status.Ok ? status : !head.Ok ? head : branch).Text).ConfigureAwait(false);
                return;
            }

            var entries = PortalRepository.ParseStatus(status.Output).Select(entry => WireJson.Object(PortalState.Json,
                ("path", entry.Path), ("originalPath", entry.OriginalPath),
                ("indexStatus", entry.IndexStatus), ("workingTreeStatus", entry.WorkingTreeStatus)));
            await JsonAsync(context, WireJson.Serialize(WireJson.Object(PortalState.Json,
                ("branch", branch.Text), ("head", head.Text), ("base", session.Plan.Base), ("entries", entries)), PortalState.Json))
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            await ProblemAsync(context, StatusCodes.Status504GatewayTimeout, "repository status timed out").ConfigureAwait(false);
        }
        catch (Exception e) when (e is Backends.BackendException or IncusException or IOException)
        {
            await ProblemAsync(context, StatusCodes.Status502BadGateway, e.Message).ConfigureAwait(false);
        }
    }

    /// <summary>A patch of the working tree or index, with literal filename selection.</summary>
    private async Task RepositoryDiffAsync(HttpContext context, string? path, bool? staged)
    {
        if (!await RepositoryAvailableAsync(context).ConfigureAwait(false))
        {
            return;
        }

        if (path is not null && (path.Length == 0 || path.Length > 4096 || path.Contains('\0') ||
                                path.StartsWith('/') || path.Split('/').Contains("..", StringComparer.Ordinal)))
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, "path must be a relative repository filename")
                .ConfigureAwait(false);
            return;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));

        try
        {
            var untracked = false;
            if (path is not null && staged != true)
            {
                var status = await RepositoryGitAsync(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path], timeout.Token)
                    .ConfigureAwait(false);
                if (!status.Ok)
                {
                    await ProblemAsync(context, StatusCodes.Status422UnprocessableEntity, status.Text).ConfigureAwait(false);
                    return;
                }

                untracked = PortalRepository.ParseStatus(status.Output)
                    .Any(entry => entry.Path == path && entry.IndexStatus == "?" && entry.WorkingTreeStatus == "?");
            }

            List<string> args = ["diff", "--no-ext-diff", "--no-textconv", "--color=never"];
            if (untracked)
            {
                args.AddRange(["--no-index", "--", "/dev/null", path!]);
            }
            else
            {
                if (staged == true)
                {
                    args.Add("--cached");
                }

                args.AddRange(["HEAD", "--"]);
                if (path is not null)
                {
                    args.Add(path);
                }
            }

            var result = await RepositoryGitAsync(args, timeout.Token).ConfigureAwait(false);
            // --no-index exits 1 when there is a difference; it is still a patch.
            if (!result.Ok && !(untracked && result.ExitCode == 1))
            {
                await ProblemAsync(context, StatusCodes.Status422UnprocessableEntity, result.Text).ConfigureAwait(false);
                return;
            }

            const int limit = 2 * 1024 * 1024;
            var diff = result.Text;
            await JsonAsync(context, WireJson.Serialize(WireJson.Object(PortalState.Json,
                ("path", path), ("staged", staged == true), ("diff", diff.Length > limit ? diff[..limit] : diff),
                ("truncated", diff.Length > limit)), PortalState.Json)).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            await ProblemAsync(context, StatusCodes.Status504GatewayTimeout, "repository diff timed out").ConfigureAwait(false);
        }
        catch (Exception e) when (e is Backends.BackendException or IncusException or IOException)
        {
            await ProblemAsync(context, StatusCodes.Status502BadGateway, e.Message).ConfigureAwait(false);
        }
    }

    private Task<RunResult> RepositoryGitAsync(IReadOnlyList<string> args, CancellationToken ct)
    {
        var mounted = Backends.DockerEngine.MachineWorkspaceBinding.Current(session.Plan.Workdir);
        IEnumerable<string> trust = mounted?.TrustedGitPaths.SelectMany(path => new[] { "-c", $"safe.directory={path}" }) ?? [];
        return session.Backend.Exec.CapturedAsync(session.Plan.InstanceName, new Backends.ExecRequest
        {
            Command = Incus.Command.AsUser(session.ContainerUser,
                ["git", "--no-pager", "--literal-pathspecs", .. trust, .. args]),
            Cwd = session.Plan.Workdir,
            Environment = Incus.Command.EnvironmentFor(session.ContainerUser,
                new Dictionary<string, string>(StringComparer.Ordinal) { ["GIT_OPTIONAL_LOCKS"] = "0" }),
        }, ct);
    }

    private async Task<bool> RepositoryAvailableAsync(HttpContext context)
    {
        if (session.Address.Length > 0)
        {
            return true;
        }

        await ProblemAsync(context, StatusCodes.Status409Conflict, "there is no instance to inspect yet").ConfigureAwait(false);
        return false;
    }

    /// <summary>
    /// A shell in the instance, latched so it survives the tab.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Sized from the query before the pty is created, so that a full-screen
    /// program started immediately lays itself out for the terminal that is
    /// actually there rather than for the default 80×24.
    /// </para>
    /// <para>
    /// It attaches to a multiplexer session named for the session, tool and
    /// optional terminal identity. A client supplies <c>?terminal=</c> for each
    /// independent tab and reuses that identity when reconnecting. Clients
    /// without an identity retain the original shared terminal behavior.
    /// </para>
    /// <para>
    /// <c>?tool=</c> opens one of the session's carried coding tools instead of
    /// a bare shell — the whole point of carrying them being that they arrive
    /// signed in — and gets a latch of its own, so an agent conversation
    /// survives a closed tab too. The name is checked against what this session
    /// actually carried rather than trusted: naming a tool and naming a command
    /// are the difference between a fixed set and an argument, and only one of
    /// those is worth having on a socket.
    /// </para>
    /// </remarks>
    private async Task ShellAsync(HttpContext context, int? cols, int? rows, string? tool, string? terminal)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest, "a shell is a websocket").ConfigureAwait(false);
            return;
        }

        if (terminal is not null && (string.IsNullOrWhiteSpace(terminal) || terminal.Length > 128))
        {
            await ProblemAsync(context, StatusCodes.Status400BadRequest,
                "terminal identity must contain 1–128 characters").ConfigureAwait(false);
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);

        if (session.Address.Length == 0)
        {
            // Said down the socket rather than as a status code: the browser's
            // WebSocket API hands a failed handshake to the page as "something
            // went wrong" and nothing else, so the only way to explain anything
            // is to accept the connection and write it on the terminal.
            await PortalShell.SayAsync(socket, "\u001b[31menvmux: there is no instance to open a shell in yet\u001b[0m\r\n",
                context.RequestAborted).ConfigureAwait(false);
            await PortalShell.CloseAsync(socket).ConfigureAwait(false);
            return;
        }

        var plan = session.Plan;

        if (tool is { Length: > 0 } &&
            !ToolMounts.Launchable(session.Tools).Contains(tool, StringComparer.Ordinal))
        {
            await PortalShell.SayAsync(
                socket,
                $"\u001b[31menvmux: '{tool}' is not a tool this session carried\u001b[0m\r\n",
                context.RequestAborted).ConfigureAwait(false);

            await PortalShell.CloseAsync(socket).ConfigureAwait(false);
            return;
        }

        var latch = PortalRepository.TerminalLatch(plan.Project, plan.Session, tool, terminal);

        // A tool is run through a login shell so that it is found the way a
        // person's own shell would find it — nvm, asdf, a ~/.local/bin that
        // only a profile puts on the PATH.
        IReadOnlyList<string> command = tool is { Length: > 0 }
            ?
            [
                Latch.Multiplexer, "new-session", "-A", "-s", latch,
                plan.Shell, "-lc", PortalShell.LaunchScript(tool, plan.Shell),
            ]
            : Latch.Shell(latch, plan.Shell);

        Backends.IInteractiveExec exec;

        try
        {
            exec = await session.Backend.Exec.InteractiveAsync(
                plan.InstanceName,
                new Backends.ExecRequest
                {
                    Command = Incus.Command.AsUser(session.ContainerUser, command),
                    Cwd = plan.Workdir,
                    Environment = Incus.Command.EnvironmentFor(session.ContainerUser, ShellEnvironment),
                    Width = Size(cols, 80),
                    Height = Size(rows, 24),
                },
                context.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IncusException or IOException or Session.SessionException)
        {
            session.Log.Warn($"portal: could not open a shell ({e.Message})");
            await PortalShell.SayAsync(socket, $"\u001b[31menvmux: {e.Message}\u001b[0m\r\n", context.RequestAborted)
                .ConfigureAwait(false);
            await PortalShell.CloseAsync(socket).ConfigureAwait(false);
            return;
        }

        session.Log.Info(tool is { Length: > 0 }
            ? $"portal: {tool} opened in {plan.InstanceName} (latched as {latch})"
            : $"portal: shell opened in {plan.InstanceName} (latched as {latch})");

        await using (exec)
        {
            await PortalShell.PumpAsync(socket, exec, context.RequestAborted).ConfigureAwait(false);
        }
    }

    /// <summary>A size the pty will accept, whatever the query said.</summary>
    private static int Size(int? asked, int fallback) =>
        asked is > 0 and <= 1000 ? asked.Value : fallback;

    /// <summary>
    /// Hold a response open and write to it as things happen.
    /// </summary>
    /// <remarks>
    /// The two streams differ only in what they write, and both end the same
    /// way: the tab is closed, the request is aborted, and the loop inside is
    /// cancelled. Neither is an error.
    /// </remarks>
    private static async Task StreamAsync(HttpContext context, Func<Func<string, Task>, Task> body)
    {
        context.Response.ContentType = "text/event-stream";
        context.Response.Headers.CacheControl = "no-store";

        // Nothing is in front of this, but a stream that is buffered anywhere
        // is a stream that arrives in one lump when it stops.
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        try
        {
            await body(async chunk =>
            {
                await context.Response.WriteAsync(chunk, context.RequestAborted).ConfigureAwait(false);
                await context.Response.Body.FlushAsync(context.RequestAborted).ConfigureAwait(false);
            }).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The tab was closed. The only way out of a stream that has no end.
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // The connection went while a write was in flight, which is the same
            // event arriving by a different door.
        }
    }

    private static async Task JsonAsync(HttpContext context, string json)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";
        await context.Response.WriteAsync(json).ConfigureAwait(false);
    }

    private static async Task ProblemAsync(HttpContext context, int status, string message)
    {
        context.Response.StatusCode = status;
        await JsonAsync(context, WireJson.Serialize(WireJson.Object(PortalState.Json, ("error", message)), PortalState.Json))
            .ConfigureAwait(false);
    }

    /// <summary>Let it run, and put whatever it says into the log.</summary>
    /// <remarks>
    /// The page finds out what happened the way the window does: the session
    /// changes, and the stream pushes it. There is nothing useful to say in the
    /// response to a button press that has not finished being pressed.
    /// </remarks>
    private void Detach(Task work, string what) => _ = Task.Run(async () =>
    {
        try
        {
            await work.ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            session.Log.Error($"portal: {what} failed — {e.Message}");
        }
    });

    /// <summary>
    /// Whether a value is the token, without saying how nearly it was.
    /// </summary>
    /// <remarks>
    /// A fixed-time comparison against a local attacker who can make a great
    /// many requests. It costs nothing here, and the version of this that
    /// compares strings is the version somebody has to explain later.
    /// </remarks>
    private bool Matches(string? given) =>
        given is { Length: > 0 } &&
        CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(given), Encoding.UTF8.GetBytes(Plan.Token));

    /// <summary>The same URL with the token taken out of it.</summary>
    private static string Without(HttpRequest request)
    {
        var query = request.Query
            .Where(q => !string.Equals(q.Key, TokenParameter, StringComparison.Ordinal))
            .SelectMany(q => q.Value.Select(v => $"{Uri.EscapeDataString(q.Key)}={Uri.EscapeDataString(v ?? "")}"))
            .ToList();

        return query.Count == 0
            ? request.Path.ToString()
            : $"{request.Path}?{string.Join('&', query)}";
    }

    private async Task RefuseAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";

        await context.Response.WriteAsync(PortalPage.Refused(session.Plan.Project, session.Plan.Session))
            .ConfigureAwait(false);
    }

    private static async Task NotBuiltAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status501NotImplemented;
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(PortalPage.NotBuilt()).ConfigureAwait(false);
    }

    /// <summary>What the window prints, so the URL and its token are readable.</summary>
    public string Describe(int port) =>
        Plan.WantsToken
            ? $"{PortalPlan.Loopback}:{port.ToString(CultureInfo.InvariantCulture)} (token in the log)"
            : $"{PortalPlan.Loopback}:{port.ToString(CultureInfo.InvariantCulture)}";
}
