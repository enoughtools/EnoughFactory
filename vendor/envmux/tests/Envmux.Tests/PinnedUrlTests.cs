using System.Text.RegularExpressions;

using Envmux.Config;
using Envmux.Routing;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// Moving a URL a server printed onto the session's own name — and only the
/// host, because everything after it is what makes the link work.
/// </summary>
public class PinnedUrlTests
{
    private const string Host = "myproj-amber-fox.envmux";

    [Theory]
    [InlineData("https://localhost:17178/login?t=8c4f1c8a", "https://myproj-amber-fox.envmux:17178/login?t=8c4f1c8a")]
    [InlineData("http://127.0.0.1:5173/", "http://myproj-amber-fox.envmux:5173/")]
    [InlineData("http://0.0.0.0:3000", "http://myproj-amber-fox.envmux:3000")]
    [InlineData("http://[::]:3000/health", "http://myproj-amber-fox.envmux:3000/health")]
    [InlineData("http://[::1]:3000", "http://myproj-amber-fox.envmux:3000")]
    [InlineData("http://LOCALHOST:8080", "http://myproj-amber-fox.envmux:8080")]
    [InlineData("http://127.0.0.2:8080", "http://myproj-amber-fox.envmux:8080")]
    [InlineData("http://+:5000", "http://myproj-amber-fox.envmux:5000")]
    [InlineData("http://*:5000", "http://myproj-amber-fox.envmux:5000")]
    public void MovesAnAddressThatMeansThisMachine(string printed, string expected) =>
        Assert.Equal(expected, PinnedUrl.Rewrite(printed, Host));

    [Fact]
    public void KeepsTheQueryByteForByte()
    {
        // The query is where the token is. Nothing in it may be normalised,
        // re-encoded or reordered — a token that has been tidied is a token
        // that no longer opens the page.
        const string token = "t=8c4f1c8a2f4e4d2b9a0c%2Fx%3Dy&Return=%2Fa%20b#frag";

        var rewritten = PinnedUrl.Rewrite($"https://localhost:17178/login?{token}", Host);

        Assert.EndsWith($"/login?{token}", rewritten, StringComparison.Ordinal);
        Assert.Equal($"https://{Host}:17178/login?{token}", rewritten);
    }

    [Theory]
    [InlineData("https://dashboard.example.com:17178/login?t=abc")]
    [InlineData("http://10.100.0.7:5173/")]
    [InlineData("http://myproj-amber-fox.envmux:5173/")]
    [InlineData("http://[fe80::1]:5173/")]
    [InlineData("http://localhost.example.com/")]
    [InlineData("http://127.example.com/")]
    public void LeavesARealHostAlone(string printed)
    {
        // A server that printed a real hostname was telling the truth about
        // where it is. Rewriting that turns a working link into a broken one.
        Assert.Equal(printed, PinnedUrl.Rewrite(printed, Host));
    }

    [Fact]
    public void LeavesAPortlessUrlWithItsScheme() =>
        Assert.Equal($"https://{Host}/", PinnedUrl.Rewrite("https://localhost/", Host));

    [Fact]
    public void KeepsUserInfoInFrontOfTheHost() =>
        Assert.Equal($"http://user:pw@{Host}:5432/db", PinnedUrl.Rewrite("http://user:pw@localhost:5432/db", Host));

    [Theory]
    [InlineData("not a url")]
    [InlineData("localhost:5173")]
    [InlineData("http://[::")]
    public void ReturnsWhatItCannotReadUnchanged(string printed) =>
        Assert.Equal(printed, PinnedUrl.Rewrite(printed, Host));

    [Fact]
    public void KeepsTheSchemeTheServerSaid()
    {
        // The server knows whether it is speaking TLS. The route's declared
        // scheme is what a person guessed before the server said.
        Assert.StartsWith("https://", PinnedUrl.Rewrite("https://localhost:1/", Host), StringComparison.Ordinal);
        Assert.StartsWith("http://", PinnedUrl.Rewrite("http://localhost:1/", Host), StringComparison.Ordinal);
    }
}

/// <summary>
/// Watching a task's output for the URL it said would be in there.
/// </summary>
public class UrlCaptureTests
{
    private static UrlCapture Aspire() =>
        new(new Regex(@"Login to the dashboard at (https://\S+)", RegexOptions.None, TimeSpan.FromSeconds(1)));

    [Fact]
    public void FindsTheFirstGroup()
    {
        var capture = Aspire();

        Assert.False(capture.Observe("info: Aspire.Hosting.DistributedApplication[0]"));
        Assert.Null(capture.Url);

        Assert.True(capture.Observe("      Login to the dashboard at https://localhost:17178/login?t=8c4f1c8a2f4e"));
        Assert.Equal("https://localhost:17178/login?t=8c4f1c8a2f4e", capture.Url);
    }

    [Fact]
    public void TheFirstMatchWins()
    {
        // A second match in the same run is a request log quoting the URL, not
        // a new one.
        var capture = Aspire();

        capture.Observe("Login to the dashboard at https://localhost:17178/login?t=first");
        Assert.False(capture.Observe("Login to the dashboard at https://localhost:17178/login?t=second"));

        Assert.Equal("https://localhost:17178/login?t=first", capture.Url);
    }

    [Fact]
    public void ARestartClearsItAndTakesTheNextOne()
    {
        var capture = Aspire();

        capture.Observe("Login to the dashboard at https://localhost:17178/login?t=first");
        capture.Reset();

        Assert.Null(capture.Url);
        Assert.True(capture.Observe("Login to the dashboard at https://localhost:17178/login?t=second"));
        Assert.Equal("https://localhost:17178/login?t=second", capture.Url);
    }

    [Fact]
    public void TakesTheWholeMatchWhenThereIsNoGroup()
    {
        var capture = new UrlCapture(new Regex(@"https?://\S+", RegexOptions.None, TimeSpan.FromSeconds(1)));

        Assert.True(capture.Observe("  ➜  Local:   http://localhost:5173/"));
        Assert.Equal("http://localhost:5173/", capture.Url);
    }

    [Fact]
    public void IgnoresAMatchThatIsEmpty()
    {
        // A pattern with an optional group that matched nothing has not found
        // a URL, and an empty string is not one worth pinning.
        var capture = new UrlCapture(new Regex(@"at (\S*)", RegexOptions.None, TimeSpan.FromSeconds(1)));

        Assert.False(capture.Observe("at "));
        Assert.Null(capture.Url);
    }
}

/// <summary>
/// Which route a <c>url</c>-declaring task speaks for, and what refuses.
/// </summary>
public class PinnedRouteTests
{
    private static SessionPlan Plan(string json) =>
        SessionPlan.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Path.Combine(Path.GetTempPath(), "myproj"),
            "amber-fox");

    private const string Aspire = """
        {
          "name": "myproj",
          "domain": "envmux",
          "routes": { "dashboard": { "port": 17178, "tls": true }, "api": 5000 },
          "tasks": {
            "aspire": {
              "command": "dotnet run --project src/AppHost",
              "ready": 17178,
              "url": "Login to the dashboard at (https://\\S+)"
            }
          }
        }
        """;

    [Fact]
    public void ReadsThePattern()
    {
        var task = Plan(Aspire).Tasks.Single();

        Assert.NotNull(task.UrlPattern);
        Assert.Matches(task.UrlPattern!, "Login to the dashboard at https://localhost:17178/login?t=x");
    }

    [Fact]
    public void TheReadyPortNamesTheRoute()
    {
        // ready: 17178 and a route on 17178 are the same server — the port
        // that means "up" is the port the route is on.
        var routes = Plan(Aspire).Routes;

        Assert.Equal("aspire", routes.Single(r => r.Name == "dashboard").PinnedBy);
        Assert.Null(routes.Single(r => r.Name == "api").PinnedBy);
    }

    [Fact]
    public void FailingThatTheNameDoes()
    {
        var routes = Plan("""
            {
              "routes": { "web": 5173 },
              "tasks": { "web": { "command": "npm run dev", "url": "Local:\\s+(http://\\S+)" } }
            }
            """).Routes;

        Assert.Equal("web", routes.Single().PinnedBy);
    }

    [Fact]
    public void TheNameIsMatchedAsASlug()
    {
        // Task names are slugged at plan time; a route called the same thing
        // before slugging is the same thing.
        var routes = Plan("""
            {
              "routes": { "Web App": 5173 },
              "tasks": { "web app": { "command": "npm run dev", "url": "(http://\\S+)" } }
            }
            """).Routes;

        Assert.Equal("web-app", routes.Single().PinnedBy);
    }

    [Fact]
    public void RefusesAUrlWithNoRouteToShowItOn()
    {
        // The alternative is a pattern that matched, a token that was captured,
        // and a routes pane that went on showing the bare port.
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "routes": { "api": 5000 },
              "tasks": { "aspire": { "command": "dotnet run", "ready": 17178, "url": "(https://\\S+)" } }
            }
            """));

        Assert.Contains("aspire", e.Message, StringComparison.Ordinal);
        Assert.Contains("ready", e.Message, StringComparison.Ordinal);
        Assert.Contains("api:5000", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesAUrlWhenThereAreNoRoutesAtAll()
    {
        var e = Assert.Throws<ConfigException>(() =>
            Plan("""{ "tasks": { "aspire": { "command": "dotnet run", "url": "(https://\\S+)" } } }"""));

        Assert.Contains("no routes", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesTwoTasksOnOneRoute()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "routes": { "web": 5173 },
              "tasks": {
                "web":  { "command": "a", "url": "(http://\\S+)" },
                "also": { "command": "b", "ready": 5173, "url": "(http://\\S+)" }
              }
            }
            """));

        Assert.Contains("web", e.Message, StringComparison.Ordinal);
        Assert.Contains("also", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesAPatternThatIsNotOne()
    {
        // At validation, not on the first line of output. config validate never
        // constructs a task, so the pattern is compiled into the plan.
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "routes": { "web": 5173 },
              "tasks": { "web": { "command": "npm run dev", "url": "(https://\\S+" } }
            }
            """));

        Assert.Contains("web", e.Message, StringComparison.Ordinal);
        Assert.Contains("regular expression", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesAUrlThatIsNotAString()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "routes": { "web": 5173 }, "tasks": { "web": { "command": "x", "url": 5173 } } }"""));

        Assert.Contains("url", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATaskWithoutAUrlPinsNothing() =>
        Assert.All(
            Plan("""{ "routes": { "web": 5173 }, "tasks": { "web": "npm run dev" } }""").Routes,
            r => Assert.Null(r.PinnedBy));

    [Fact]
    public void AnEmptyUrlIsNoUrl() =>
        Assert.Null(Plan("""{ "tasks": { "web": { "command": "x", "url": "  " } } }""").Tasks.Single().UrlPattern);

    [Fact]
    public void RoundTripsThroughTheWriter()
    {
        var config = System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(Aspire, SessionConfig.JsonOptions)!;
        var written = System.Text.Json.JsonSerializer.Serialize(config, SessionConfig.JsonOptions);
        var again = System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(written, SessionConfig.JsonOptions)!;

        Assert.Equal(@"Login to the dashboard at (https://\S+)", again.Tasks!["aspire"].Url);
    }

    [Fact]
    public void TheRouteIsItsPortUntilTheTaskHasPrinted()
    {
        var plan = Plan(Aspire);
        var listed = RouteListing.Build(plan, 8080, "10.100.0.2");
        var dashboard = listed.Single(r => r.Name == "dashboard");

        Assert.Equal("https://localhost:17178/", dashboard.Url);
        Assert.False(dashboard.IsPinned);
    }

    [Fact]
    public void AndTheUrlItPrintedAfterwards()
    {
        var plan = Plan(Aspire);
        var listed = RouteListing.Build(plan, 8080, "10.100.0.2", new Dictionary<string, string>
        {
            ["aspire"] = "https://localhost:17178/login?t=8c4f1c8a2f4e4d2b9a0c",
        });

        var dashboard = listed.Single(r => r.Name == "dashboard");

        Assert.Equal("https://localhost:17178/login?t=8c4f1c8a2f4e4d2b9a0c", dashboard.Url);
        Assert.True(dashboard.IsPinned);
        Assert.Equal(17178, dashboard.Port);

        // The other route is untouched, and so is the portal.
        Assert.Equal("http://localhost:5000/", listed.Single(r => r.Name == "api").Url);
        Assert.False(listed.Single(r => r.IsPortal).IsPinned);
    }

    [Fact]
    public void APrintedUrlForATaskThatPinsNothingChangesNothing()
    {
        var plan = Plan("""{ "routes": { "web": 5173 }, "tasks": { "web": "npm run dev" } }""");
        var listed = RouteListing.Build(plan, 8080, "10.100.0.2", new Dictionary<string, string>
        {
            ["web"] = "http://localhost:5173/somewhere",
        });

        Assert.Equal("http://localhost:5173/", listed.Single(r => !r.IsPortal).Url);
    }

    [Fact]
    public void PinningIsOnTheRoute()
    {
        // The route knows what the host should be — localhost, which is the
        // instance in the session's browser; the task only knows what its
        // server said, which here is every address at once.
        var route = new RoutedEndpoint("dashboard", 17178, "p-s.envmux", RouteConfig.Https);
        var pinned = route.Pin("https://[::]:17178/login?t=abc");

        Assert.Equal("https://localhost:17178/login?t=abc", pinned.Url);
        Assert.True(pinned.IsPinned);
        Assert.False(route.IsPinned);
        Assert.Equal("https://localhost:17178/", route.Url);
    }
}
