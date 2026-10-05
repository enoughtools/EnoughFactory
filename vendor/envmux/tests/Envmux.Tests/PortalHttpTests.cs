using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

using Envmux.Config;
using Envmux.Portal;
using Envmux.Routing;
using Envmux.Session;

using LiveSession = Envmux.Session.Session;

namespace Envmux.Tests;

/// <summary>
/// What the portal answers, over a real listener.
/// </summary>
/// <remarks>
/// <para>
/// A real Kestrel with a real YARP beside it, because the two things worth
/// proving are both about the boundary between them: that nothing gets past the
/// token, and that the portal's own paths do not shadow a container's. Neither
/// is visible from a unit test of the handler.
/// </para>
/// <para>
/// No host and no git. The session object is built but never started, which
/// is enough for everything here — a shell is the one thing that needs a
/// running instance, and that needs a host.
/// </para>
/// </remarks>
public class PortalHttpTests
{
    /// <summary>A session that exists on paper: a plan, and no container behind it.</summary>
    private static LiveSession Paper(string config, string? directory = null) =>
        new(SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(config, SessionConfig.JsonOptions)!,
            directory ?? Directory.GetCurrentDirectory(),
            "portal"));

    private static async Task<PortalListener> ServeAsync(LiveSession session, int port)
    {
        var listener = new PortalListener(session);
        await listener.StartAsync(PortSpec.Single(port));
        return listener;
    }

    private static HttpRequestMessage Get(PortalListener router, string path, string host) =>
        new(HttpMethod.Get, $"http://127.0.0.1:{router.Port}{path}") { Headers = { Host = host } };

    [Fact]
    public async Task RefusesEverythingWithoutTheToken()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45230);
        using var http = new HttpClient();

        using var page = await http.SendAsync(Get(router, "/", "127.0.0.1"));
        using var state = await http.SendAsync(Get(router, "/api/state", "127.0.0.1"));

        Assert.Equal(HttpStatusCode.Unauthorized, page.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, state.StatusCode);
    }

    /// <summary>
    /// A websocket request is recognised as one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The portal's terminal had never worked. Nothing called
    /// <c>UseWebSockets()</c>, so the upgrade headers were never inspected,
    /// <c>context.WebSockets.IsWebSocketRequest</c> was false for every request,
    /// and <c>/api/shell</c> answered "a shell is a websocket" to a request that
    /// was one — which the client sees as
    /// <c>The server returned status code '400' when status code '101' was
    /// expected</c>.
    /// </para>
    /// <para>
    /// Only the handshake is asserted. This session has no instance behind it,
    /// so the exec after the handshake cannot succeed and would hang — hence the
    /// short deadline, and hence asserting on how the connect failed rather than
    /// on it working.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task AShellRequestIsSeenAsAWebsocket()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45238);

        using var socket = new System.Net.WebSockets.ClientWebSocket();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        var uri = new Uri($"ws://127.0.0.1:{router.Port}/api/shell?k={session.Plan.Portal.Token}");

        string? failure = null;

        try
        {
            await socket.ConnectAsync(uri, deadline.Token);
        }
        catch (Exception e)
        {
            failure = e.Message;
        }

        // 400 is the middleware being absent. Anything else — including a
        // handshake that succeeded and an exec that then went nowhere — is it
        // being present, which is the whole distinction this protects.
        Assert.DoesNotContain("400", failure ?? "", StringComparison.Ordinal);
    }

    /// <summary>
    /// The token goes in once and lives in a cookie after that.
    /// </summary>
    /// <remarks>
    /// The redirect is the point: what is bookmarked, screenshotted and pasted
    /// into an issue is the URL after it, and that one has no secret in it.
    /// </remarks>
    [Fact]
    public async Task TradesTheTokenForACookieAndTakesItOutOfTheUrl()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        var token = session.Plan.Portal.Token;
        await using var router = await ServeAsync(session, 45231);

        using var handler = new HttpClientHandler { AllowAutoRedirect = false };
        using var http = new HttpClient(handler);

        using var arrived = await http.SendAsync(Get(router, $"/?k={token}", "127.0.0.1"));

        Assert.Equal(HttpStatusCode.Found, arrived.StatusCode);
        Assert.Equal("/", arrived.Headers.Location?.ToString());
        Assert.Contains(arrived.Headers.GetValues("Set-Cookie"), c => c.Contains(token, StringComparison.Ordinal));

        using var again = Get(router, "/api/state", "127.0.0.1");
        again.Headers.Add("Cookie", $"envmux-portal={token}");
        using var state = await http.SendAsync(again);

        Assert.Equal(HttpStatusCode.OK, state.StatusCode);
    }

    [Fact]
    public async Task AnswersTheApiWithTheSessionItIsLookingAt()
    {
        var session = Paper("""{"name":"proj","domain":"localhost","routes":{"web":5173}}""");
        await using var router = await ServeAsync(session, 45232);
        using var http = new HttpClient();

        using var request = Get(router, $"/api/state?k={session.Plan.Portal.Token}", "127.0.0.1");
        using var response = await http.SendAsync(request);

        var state = JsonSerializer.Deserialize<JsonElement>(await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("proj", state.GetProperty("project").GetString());
        Assert.Equal("portal", state.GetProperty("session").GetString());
        Assert.Equal("localhost", state.GetProperty("domain").GetString());
        Assert.Equal("proj-portal", state.GetProperty("instanceName").GetString());
    }

    /// <summary>
    /// The instance's own <c>/api</c> can never be shadowed, because it is not
    /// on this listener at all.
    /// </summary>
    /// <remarks>
    /// This used to be a real hazard and a scoped route group: the portal and
    /// every proxied route arrived on one port, so <c>/api/state</c> would have
    /// answered on a project's own hostname too. With an address per instance
    /// there is nothing to shadow — a request for the session's hostname does
    /// not reach this process — and the check that remains is that the listener
    /// refuses to answer for anything but loopback.
    /// </remarks>
    [Fact]
    public async Task RefusesToAnswerForTheSessionsOwnHostname()
    {
        var session = Paper("""{"name":"proj","domain":"localhost","routes":{"web":5173}}""");

        await using var router = await ServeAsync(session, 45233);
        using var http = new HttpClient();

        using var request = Get(router, $"/api/state?k={session.Plan.Portal.Token}", session.Plan.Hostname);
        using var response = await http.SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ServesWithoutATokenWhenToldTo()
    {
        var session = Paper("""{"name":"proj","domain":"localhost","portal":{"token":false}}""");
        await using var router = await ServeAsync(session, 45234);
        using var http = new HttpClient();

        using var response = await http.SendAsync(Get(router, "/api/state", "localhost"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    /// <summary>
    /// A <c>Host</c> the listener does not serve is refused rather than
    /// answered.
    /// </summary>
    /// <remarks>
    /// This is the DNS rebinding defence and, since the proxy went, the only
    /// thing the header is checked for. A page on an attacker's domain that
    /// resolves to 127.0.0.1 reaches this listener with that domain in the
    /// header; the same-origin policy does not stop it, and the header check
    /// does.
    /// </remarks>
    [Fact]
    public async Task RefusesAHostItDoesNotServe()
    {
        var session = Paper("""{"name":"proj","domain":"localhost","portal":{"token":false}}""");
        await using var router = await ServeAsync(session, 45235);
        using var http = new HttpClient();

        using var refused = await http.SendAsync(Get(router, "/", "evil.example"));
        using var served = await http.SendAsync(Get(router, "/", "127.0.0.1"));

        Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
        Assert.Equal(HttpStatusCode.OK, served.StatusCode);
    }

    /// <summary>
    /// The page's own assets are served, and they have dots in their names.
    /// </summary>
    /// <remarks>
    /// MapFallback's default pattern is <c>{*path:nonfile}</c>, which declines
    /// any path whose last segment looks like a filename. That default assumes
    /// static files are on disk in front of the fallback; here they are inside
    /// the binary and the fallback is the only thing that serves them, so the
    /// default 404s every script and stylesheet the page asks for — which is a
    /// blank tab and a console full of MIME errors, and nothing in the log.
    /// </remarks>
    [SkippableFact]
    public async Task ServesThePagesOwnAssets()
    {
        Skip.IfNot(PortalAssets.Built, "this build has no portal page in it (no Node when it was built)");

        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45237);
        using var http = new HttpClient();

        var asset = PortalAssets.Paths.First(p => p.StartsWith("assets/", StringComparison.Ordinal));

        using var response = await http.SendAsync(
            Get(router, $"/{asset}?k={session.Plan.Portal.Token}", "127.0.0.1"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Content.Headers.ContentLength > 0);
    }

    /// <summary>A path that is not an asset is the page, because the page routes itself.</summary>
    [SkippableFact]
    public async Task AnswersAnyOtherPathWithThePage()
    {
        Skip.IfNot(PortalAssets.Built, "this build has no portal page in it (no Node when it was built)");

        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45238);
        using var http = new HttpClient();

        using var page = await http.SendAsync(Get(router, $"/anything?k={session.Plan.Portal.Token}", "127.0.0.1"));
        using var missing = await http.SendAsync(Get(router, "/assets/nope.js", "127.0.0.1"));

        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Contains("<div id=\"root\">", await page.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        // A missing file is missing rather than the page: a stale tab asking for
        // an asset that no longer exists should be told so, not handed HTML.
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    /// <summary>
    /// The token as a bearer opens the API the way the cookie does — and a wrong one does not.
    /// </summary>
    /// <remarks>
    /// For clients that are programs: the command line, and the room's client in
    /// the instance. Nothing is redirected and no cookie is set, because a
    /// program has no address bar to take a secret out of.
    /// </remarks>
    [Fact]
    public async Task TakesTheTokenAsABearer()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45240);
        using var http = new HttpClient();

        using var right = Get(router, "/api/state", "127.0.0.1");
        right.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.Plan.Portal.Token);
        using var accepted = await http.SendAsync(right);

        using var wrong = Get(router, "/api/state", "127.0.0.1");
        wrong.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('x', session.Plan.Portal.Token.Length));
        using var refused = await http.SendAsync(wrong);

        using var other = Get(router, "/api/state", "127.0.0.1");
        other.Headers.Authorization = new AuthenticationHeaderValue("Basic", session.Plan.Portal.Token);
        using var wrongScheme = await http.SendAsync(other);

        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.False(accepted.Headers.Contains("Set-Cookie"));
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongScheme.StatusCode);
    }

    /// <summary>
    /// The bridge serves the room and nothing else, to the bearer and nobody else.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Bound here to loopback on a second port, standing in for the address that
    /// faces the Incus host; what is under test is the door, not the address.
    /// The portal already holds the first port on loopback, so the bridge walks
    /// to the next — which is also the walk it does for real when something
    /// else has that number on the bridge address.
    /// </para>
    /// <para>
    /// A non-chat path is a 404 <em>with</em> a valid bearer: the shell and the
    /// tasks are not locked on this door, they are absent from it. And the
    /// cookie and the query — the browser's two ways in — open nothing here.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task TheBridgeServesOnlyTheRoomAndOnlyToTheBearer()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        var token = session.Plan.Portal.RoomToken;
        var listener = new PortalListener(session);
        await listener.StartAsync(PortSpec.Single(45241), IPAddress.Loopback);
        await using var router = listener;
        using var http = new HttpClient();

        var bridge = Assert.IsType<IPEndPoint>(router.Bridge);
        Assert.Equal(45242, bridge.Port);

        HttpRequestMessage At(string path, string host, string? bearer)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{bridge.Port}{path}") { Headers = { Host = host } };

            if (bearer is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            }

            return request;
        }

        using var chat = await http.SendAsync(At("/api/chat", "127.0.0.1:8078", token));
        using var anyHost = await http.SendAsync(At("/api/chat", "whatever.example", token));
        using var noBearer = await http.SendAsync(At("/api/chat", "127.0.0.1", null));
        using var wrongBearer = await http.SendAsync(At("/api/chat", "127.0.0.1", new string('x', token.Length)));
        using var byQuery = await http.SendAsync(At($"/api/chat?k={token}", "127.0.0.1", null));

        using var withCookie = At("/api/chat", "127.0.0.1", null);
        withCookie.Headers.Add("Cookie", $"envmux-portal={token}");
        using var byCookie = await http.SendAsync(withCookie);

        using var state = await http.SendAsync(At("/api/state", "127.0.0.1", token));
        using var shell = await http.SendAsync(At("/api/shell", "127.0.0.1", token));
        using var page = await http.SendAsync(At("/", "127.0.0.1", token));
        using var asset = await http.SendAsync(At("/assets/index.js", "127.0.0.1", token));

        Assert.Equal(HttpStatusCode.OK, chat.StatusCode);
        Assert.Equal(HttpStatusCode.OK, anyHost.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, noBearer.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongBearer.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, byQuery.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, byCookie.StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, state.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, shell.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, page.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, asset.StatusCode);

        // And the portal proper is untouched by the bridge being there.
        using var portal = await http.SendAsync(Get(router, $"/api/state?k={session.Plan.Portal.Token}", "127.0.0.1"));
        Assert.Equal(HttpStatusCode.OK, portal.StatusCode);
    }

    /// <summary>No bridge asked for, none bound.</summary>
    [Fact]
    public async Task HasNoBridgeUnlessAsked()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45243);

        Assert.Null(router.Bridge);
    }

    /// <summary>
    /// The room over the wire, the way the instance's client drives it.
    /// </summary>
    /// <remarks>
    /// The whole exchange a guest has, against a real listener and a real
    /// directory: the recent room as text with a cursor, a long poll that is
    /// woken by a line the workstation side appends, and a post of stamped
    /// lines that is answered with the gap and not the echo. The framing and
    /// the cursor semantics have unit tests of their own; this is that they
    /// survive HTTP.
    /// </remarks>
    [Fact]
    public async Task CarriesTheRoomOverTheWire()
    {
        var repo = Directory.CreateTempSubdirectory("envmux-wire-").FullName;

        try
        {
            var room = Path.Combine(repo, ".context", "chatroom", "2026-09-03");
            Directory.CreateDirectory(room);
            await File.WriteAllTextAsync(Path.Combine(room, "1115.txt"), "[11:16] chef: one\n");

            var session = Paper("""{"name":"proj","domain":"localhost"}""", repo);
            var token = session.Plan.Portal.RoomToken;
            var listener = new PortalListener(session);
            await listener.StartAsync(PortSpec.Single(45244), IPAddress.Loopback);
            await using var router = listener;
            using var http = new HttpClient();

            var bridge = Assert.IsType<IPEndPoint>(router.Bridge);

            HttpRequestMessage Wire(HttpMethod method, string query, string? body = null)
            {
                var request = new HttpRequestMessage(method, $"http://127.0.0.1:{bridge.Port}/api/chat?{query}");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/plain"));

                if (body is not null)
                {
                    request.Content = new StringContent(body, Encoding.UTF8, "text/plain");
                }

                return request;
            }

            // 1. The recent room, whole, as text — and where it ends.
            using var recent = await http.SendAsync(Wire(HttpMethod.Get, "buckets=4"));
            Assert.Equal(HttpStatusCode.OK, recent.StatusCode);
            Assert.Equal("2026-09-03/1115.txt\t[11:16] chef: one\n", await recent.Content.ReadAsStringAsync());
            var cursor = Assert.Single(recent.Headers.GetValues("X-Envmux-Cursor"));
            Assert.Equal("2026-09-03/1115.txt:1", cursor);

            // 2. A long poll, woken by a line appended on this side while it waits.
            var waiting = http.SendAsync(Wire(HttpMethod.Get, $"after={Uri.EscapeDataString(cursor)}&wait=20"));
            await Task.Delay(300);
            Assert.False(waiting.IsCompleted);
            await File.AppendAllTextAsync(Path.Combine(room, "1115.txt"), "[11:17] chef: @feat-login go\n");

            using var woken = await waiting.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal("2026-09-03/1115.txt\t[11:17] chef: @feat-login go\n", await woken.Content.ReadAsStringAsync());
            cursor = Assert.Single(woken.Headers.GetValues("X-Envmux-Cursor"));
            Assert.Equal("2026-09-03/1115.txt:2", cursor);

            // 3. The guest posts two stamped lines while the chef, unseen, says
            //    one more: the answer is the chef's line and the cursor past all
            //    three, and the guest's own lines are not echoed back.
            await File.AppendAllTextAsync(Path.Combine(room, "1115.txt"), "[11:18] chef: meanwhile\n");

            using var posted = await http.SendAsync(Wire(
                HttpMethod.Post,
                $"after={Uri.EscapeDataString(cursor)}",
                "2026-09-03/1115.txt\t[11:18] feat-login: on it\n2026-09-03/1115.txt\t    with a continuation\n"));

            Assert.Equal(HttpStatusCode.Created, posted.StatusCode);
            Assert.Equal("2026-09-03/1115.txt\t[11:18] chef: meanwhile\n", await posted.Content.ReadAsStringAsync());
            Assert.Equal("2026-09-03/1115.txt:5", Assert.Single(posted.Headers.GetValues("X-Envmux-Cursor")));

            Assert.Equal(
                "[11:16] chef: one\n[11:17] chef: @feat-login go\n[11:18] chef: meanwhile\n[11:18] feat-login: on it\n    with a continuation\n",
                await File.ReadAllTextAsync(Path.Combine(room, "1115.txt")));

            // 4. A bucket the API will not write to is refused, and nothing lands.
            using var refused = await http.SendAsync(Wire(HttpMethod.Post, "", "../../etc/cron.d/x\t* * * * * root true\n"));
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

            // 5. The JSON face of the same read carries the cursor too, for the page and the CLI.
            using var json = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{router.Port}/api/chat")
            {
                Headers = { Host = "127.0.0.1", Authorization = new AuthenticationHeaderValue("Bearer", session.Plan.Portal.Token) },
            };
            using var parsed = await http.SendAsync(json);
            var body = JsonSerializer.Deserialize<JsonElement>(await parsed.Content.ReadAsStringAsync());
            Assert.Equal("2026-09-03/1115.txt:5", body.GetProperty("cursor").GetString());
            Assert.Equal(4, body.GetProperty("lines").GetArrayLength());
            Assert.Equal("on it\nwith a continuation", body.GetProperty("lines")[3].GetProperty("text").GetString());
        }
        finally
        {
            try
            {
                Directory.Delete(repo, recursive: true);
            }
            catch (IOException)
            {
                // A leaked temp directory is not worth failing a test over.
            }
        }
    }

    [Fact]
    public async Task SaysNothingUsefulAboutATaskItDoesNotHave()
    {
        var session = Paper("""{"name":"proj","domain":"localhost"}""");
        await using var router = await ServeAsync(session, 45236);
        using var http = new HttpClient();

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"http://127.0.0.1:{router.Port}/api/tasks/nope/restart?k={session.Plan.Portal.Token}")
        {
            Headers = { Host = "127.0.0.1" },
        };

        using var response = await http.SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}

/// <summary>The one control message the shell socket understands.</summary>
public class PortalResizeTests
{
    [Theory]
    [InlineData("""{"resize":{"cols":120,"rows":40}}""", 120, 40)]
    public void ReadsAResize(string frame, int columns, int rows)
    {
        Assert.True(PortalShell.TryReadResize(Encoding.UTF8.GetBytes(frame), out var c, out var r));
        Assert.Equal(columns, c);
        Assert.Equal(rows, r);
    }

    /// <summary>Anything else is keystrokes, including things that are nearly this.</summary>
    [Theory]
    [InlineData("ls -la")]
    [InlineData("{")]
    [InlineData("""{"resize":{"cols":0,"rows":40}}""")]
    [InlineData("""{"resize":{"cols":120}}""")]
    [InlineData("""{"size":{"cols":120,"rows":40}}""")]
    public void TreatsAnythingElseAsTyping(string frame) =>
        Assert.False(PortalShell.TryReadResize(Encoding.UTF8.GetBytes(frame), out _, out _));
}
