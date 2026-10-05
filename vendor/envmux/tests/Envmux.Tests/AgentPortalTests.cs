using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using Envmux.Agents;
using Envmux.Config;
using Envmux.Portal;
using Envmux.Session;

using LiveSession = Envmux.Session.Session;

namespace Envmux.Tests;

/// <summary>
/// The portal's control plane for remote agents, over a real listener.
/// </summary>
/// <remarks>
/// A session on paper in a temporary repository: no host, no instance, and no
/// agent is spawned. What is proved is that the endpoints read and write the
/// same files the <c>agent</c> command does — the room under <c>.context/</c>,
/// the registry under <c>.envmux/agents/</c> — and that nothing gets past the
/// token.
/// </remarks>
public class AgentPortalTests : IDisposable
{
    private readonly string _repo = Directory.CreateTempSubdirectory("envmux-portal-agents-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);

        try
        {
            Directory.Delete(_repo, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private LiveSession Paper() =>
        new(SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>("""{"name":"proj","domain":"localhost"}""", SessionConfig.JsonOptions)!,
            _repo,
            "chef"));

    private static async Task<PortalListener> ServeAsync(LiveSession session, int port)
    {
        var listener = new PortalListener(session);
        await listener.StartAsync(PortSpec.Single(port));
        return listener;
    }

    private static HttpRequestMessage Request(HttpMethod method, PortalListener router, string path, string? token) =>
        new(method, $"http://127.0.0.1:{router.Port}{path}{(token is null ? "" : (path.Contains('?') ? "&" : "?") + "k=" + token)}")
        {
            Headers = { Host = "127.0.0.1" },
        };

    [Fact]
    public async Task ListsNoAgentsForARepositoryThatHasNone()
    {
        var session = Paper();
        await using var router = await ServeAsync(session, 45250);
        using var http = new HttpClient();

        using var response = await http.SendAsync(Request(HttpMethod.Get, router, "/api/agents", session.Plan.Portal.Token));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal("#proj", body.GetProperty("room").GetString());
        Assert.Empty(body.GetProperty("agents").EnumerateArray());
    }

    [Fact]
    public async Task RefusesTheControlPlaneWithoutTheToken()
    {
        var session = Paper();
        await using var router = await ServeAsync(session, 45251);
        using var http = new HttpClient();

        using var agents = await http.SendAsync(Request(HttpMethod.Get, router, "/api/agents", null));
        using var chat = await http.SendAsync(Request(HttpMethod.Get, router, "/api/chat", null));

        Assert.Equal(HttpStatusCode.Unauthorized, agents.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, chat.StatusCode);
    }

    /// <summary>A line posted here is a line in the room's files, in the convention's shape, readable back.</summary>
    [Fact]
    public async Task SpeaksIntoTheRoomAndReadsItBack()
    {
        var session = Paper();
        await using var router = await ServeAsync(session, 45252);
        using var http = new HttpClient();

        using var post = Request(HttpMethod.Post, router, "/api/chat", session.Plan.Portal.Token);
        post.Content = JsonContent.Create(new { text = "start with the tests", to = "feat-login" });
        using var said = await http.SendAsync(post);

        Assert.Equal(HttpStatusCode.Created, said.StatusCode);

        var line = (await said.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("line").GetString()!;
        Assert.Matches(@"^\[\d\d:\d\d\] chef: @feat-login start with the tests$", line);

        var bucket = Chatroom.BucketPath(_repo, DateTime.Now);
        Assert.True(File.Exists(bucket));
        Assert.Contains(line, await File.ReadAllTextAsync(bucket), StringComparison.Ordinal);

        using var read = await http.SendAsync(Request(HttpMethod.Get, router, "/api/chat", session.Plan.Portal.Token));
        var room = await read.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(".context/chatroom", room.GetProperty("path").GetString());
        var lines = room.GetProperty("lines").EnumerateArray().ToList();
        var last = Assert.Single(lines);
        Assert.Equal("chef", last.GetProperty("name").GetString());
        Assert.Equal("@feat-login start with the tests", last.GetProperty("text").GetString());
        Assert.False(last.GetProperty("isEvent").GetBoolean());
    }

    [Fact]
    public async Task RefusesNothingToSayAndABadAddressee()
    {
        var session = Paper();
        await using var router = await ServeAsync(session, 45253);
        using var http = new HttpClient();

        using var empty = Request(HttpMethod.Post, router, "/api/chat", session.Plan.Portal.Token);
        empty.Content = JsonContent.Create(new { text = "" });
        using var refused = await http.SendAsync(empty);
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

        using var bad = Request(HttpMethod.Post, router, "/api/chat", session.Plan.Portal.Token);
        bad.Content = JsonContent.Create(new { text = "hi", to = "Not-A-Nick" });
        using var refusedToo = await http.SendAsync(bad);
        Assert.Equal(HttpStatusCode.BadRequest, refusedToo.StatusCode);

        Assert.Empty(Chatroom.ReadRecent(_repo));
    }

    [Fact]
    public async Task StoppingAnAgentNobodyStartedIsNotFound()
    {
        var session = Paper();
        await using var router = await ServeAsync(session, 45254);
        using var http = new HttpClient();

        using var stop = Request(HttpMethod.Post, router, "/api/agents/nobody/stop", session.Plan.Portal.Token);
        stop.Content = JsonContent.Create(new { });
        using var response = await http.SendAsync(stop);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// <summary>An agent the command line started is listed here, with no word passing between the two processes.</summary>
    [Fact]
    public async Task ListsWhatTheCommandLineStarted()
    {
        var session = Paper();
        AgentRegistry.Start(_repo, SessionPlan.Resolve(SessionConfig.Load(_repo), _repo, "feat-login"), "Add a login page.", "hazel",
            (_, _) => Environment.ProcessId);

        await using var router = await ServeAsync(session, 45255);
        using var http = new HttpClient();

        using var response = await http.SendAsync(Request(HttpMethod.Get, router, "/api/agents", session.Plan.Portal.Token));
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var agent = Assert.Single(body.GetProperty("agents").EnumerateArray());
        Assert.Equal("feat-login", agent.GetProperty("name").GetString());
        Assert.Equal(AgentState.Launching, agent.GetProperty("state").GetString());
        Assert.Equal("hazel", agent.GetProperty("delegator").GetString());

        using var stop = Request(HttpMethod.Post, router, "/api/agents/feat-login/stop", session.Plan.Portal.Token);
        stop.Content = JsonContent.Create(new { });
        using var stopped = await http.SendAsync(stop);

        Assert.Equal(HttpStatusCode.Accepted, stopped.StatusCode);
        Assert.True(AgentRegistry.StopRequested(_repo, "feat-login"));
    }
}
