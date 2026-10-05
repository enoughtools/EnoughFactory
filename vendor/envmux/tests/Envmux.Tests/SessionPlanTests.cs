using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

public class SessionPlanTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-test-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private SessionPlan Plan(string? json = null, string? session = "amber-fox")
    {
        if (json is not null)
        {
            File.WriteAllText(Path.Combine(_dir, SessionConfig.FileName), json);
        }

        return SessionPlan.Resolve(SessionConfig.Load(_dir), _dir, session);
    }

    [Fact]
    public void BrowserOpenNamesARouteOrIsRefused()
    {
        // browser.open picks where `b` lands. A name that is not a route is a
        // typo, caught here rather than as a browser error at http://proof.
        var plan = Plan("""{"routes":{"docs":5173,"proof":5174},"browser":{"open":"proof"}}""");
        Assert.Equal("proof", plan.Browser.Open);

        var e = Assert.Throws<ConfigException>(() =>
            Plan("""{"routes":{"docs":5173},"browser":{"open":"proof"}}"""));
        Assert.Contains("not a route", e.Message, StringComparison.Ordinal);
        Assert.Contains("docs", e.Message, StringComparison.Ordinal);

        Assert.Equal("localhost:9000", Plan("""{"browser":{"open":"localhost:9000"}}""").Browser.Open);
    }

    [Fact]
    public void AMissingNetworkIsNamedAsTheHostsFileNamesIt()
    {
        // The check is against the configured network, so the message has to
        // be too — "no envmux0" on a host that was pointed at labbr0 sends
        // somebody looking for a bridge that was never meant to be there.
        var adopted = Envmux.Session.Session.MissingNetwork(
            new Host.HostConfig { Provider = Host.HostConfig.Incus, Network = "labbr0" });

        Assert.Contains("'labbr0'", adopted, StringComparison.Ordinal);
        Assert.Contains("--network", adopted, StringComparison.Ordinal);
        Assert.DoesNotContain("seed", adopted, StringComparison.Ordinal);

        // And the advice is the provider's: only a VM envmux built has a seed
        // that could have failed to apply.
        var built = Envmux.Session.Session.MissingNetwork(new Host.HostConfig());

        Assert.Contains("'envmux0'", built, StringComparison.Ordinal);
        Assert.Contains("seed", built, StringComparison.Ordinal);
        Assert.DoesNotContain("--network", built, StringComparison.Ordinal);
    }

    [Fact]
    public void NoFileIsAValidSession()
    {
        var plan = Plan();

        Assert.Equal(SessionConfig.DefaultImage, plan.Image);
        Assert.Equal(SessionConfig.DefaultWorkdir, plan.Workdir);
        Assert.Equal(SessionConfig.DefaultShell, plan.Shell);
        Assert.Equal(SessionConfig.DefaultPort, plan.Port.First);
        Assert.Empty(plan.Routes);
        Assert.Empty(plan.Env);
        Assert.Empty(plan.Tasks);
        Assert.NotEmpty(plan.Project);

        // Keeping the instance is the default. Commits come back through a
        // bundle; anything uncommitted lives only in there, and deleting
        // someone's uncommitted work by default is unforgivable.
        Assert.True(plan.KeepOnExit);
        Assert.Equal("envmux/amber-fox", plan.Branch);
        Assert.Equal(GitConfig.DefaultBase, plan.Base);
    }

    [Fact]
    public void ProjectNameDefaultsToTheDirectory()
    {
        var expected = Slug.FromDirectory(_dir);
        Assert.Equal(expected, Plan().Project);
    }

    [Fact]
    public void AnUnnamedSessionGetsAGeneratedName()
    {
        var plan = Plan(session: null);
        Assert.NotEmpty(plan.Session);
        Assert.Equal(plan.Session, Slug.From(plan.Session));
    }

    [Fact]
    public void TheSessionNameIsTheWholeIdentity()
    {
        var plan = Plan("""{ "name": "myproj" }""", "feat/login");

        // One name for the branch, the instance, and the hostname that
        // instance answers on — so nothing has to be correlated by hand across
        // four sessions running in the same directory.
        Assert.Equal("feat-login", plan.Session);
        Assert.Equal("envmux/feat-login", plan.Branch);
        Assert.Equal("myproj-feat-login", plan.InstanceName);
        Assert.Equal($"myproj-feat-login.{plan.Domain}", plan.Hostname);

        // And the fifth: the name the editor opens the workdir under, so a
        // recents list full of sessions is not a recents list full of `work`.
        Assert.Equal("/myproj_feat-login", plan.WorkdirLink);
    }

    [Fact]
    public void TheWorkdirLinkSplitsBackIntoItsHalves()
    {
        // An underscore because a slug never contains one — everything that is
        // not a letter or digit became a hyphen — so the two halves read back
        // unambiguously where `-` would not, and the name cannot collide with
        // anything a Debian root ships with.
        var plan = Plan("""{ "name": "my.proj v2" }""", "feat/login_page");

        Assert.Equal("/my-proj-v2_feat-login-page", plan.WorkdirLink);
        Assert.Equal(2, plan.WorkdirLink.Split('_').Length);
        Assert.DoesNotContain("_", plan.Project, StringComparison.Ordinal);
        Assert.DoesNotContain("_", plan.Session, StringComparison.Ordinal);
    }

    [Fact]
    public void TheWorkdirLinkIsNotTheWorkdir()
    {
        // Tasks, shells, the clone and ENVMUX_WORKDIR all stay on the real path.
        // The link is for the editor and nothing else, so nothing else moves.
        var plan = Plan("""{ "name": "myproj", "workdir": "/src", "tasks": { "dev": "npm run dev" } }""");

        Assert.Equal("/src", plan.Workdir);
        Assert.Equal("/src", plan.Tasks.Single().Workdir);
        Assert.Equal("/myproj_amber-fox", plan.WorkdirLink);
        Assert.Equal(plan.WorkdirLink, plan.EditorFolder);
    }

    [Fact]
    public void AnInstanceNameIsAlsoADnsLabel()
    {
        // Which stops at 63 characters. Caught here, because Incus would refuse
        // the creation several seconds into a session that looked like it was
        // starting, with a message about names.
        var e = Assert.Throws<ConfigException>(() => Plan(
            """{ "name": "a-project-with-a-really-rather-long-name-for-testing-purposes" }""",
            "and-a-long-session-name-too"));

        Assert.Contains("63", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadsTheGitSection()
    {
        var plan = Plan("""
            {
              "git": { "branchPrefix": "wip/", "base": "main", "keepOnExit": false }
            }
            """, "thing");

        Assert.Equal("wip/thing", plan.Branch);
        Assert.Equal("main", plan.Base);
        Assert.False(plan.KeepOnExit);
    }

    [Fact]
    public void CommentsAndTrailingCommasAreAllowed()
    {
        var plan = Plan("""
            {
              // the thing we are building
              "name": "myproj",
              "routes": { "vite": 5173, },
            }
            """);

        Assert.Equal("myproj", plan.Project);
        Assert.Equal($"myproj-amber-fox.{plan.Domain}", Single(plan).Hostname);
        Assert.Equal(5173, Single(plan).Port);
    }

    [Fact]
    public void ReadsEveryField()
    {
        var plan = Plan("""
            {
              "name": "myproj",
              "image": "alpine:3.20",
              "workdir": "/src",
              "shell": "/bin/sh",
              "tasks": { "install": { "command": "npm ci", "kind": "once" } },
              "env": { "NODE_ENV": "development" },
              "routes": { "vite": 5173 },
              "port": 9000,
              "domain": "dev.test"
            }
            """);

        Assert.Equal("myproj", plan.Project);
        Assert.Equal("alpine:3.20", plan.Image);
        Assert.Equal("/src", plan.Workdir);
        Assert.Equal("/bin/sh", plan.Shell);
        Assert.Equal("npm ci", plan.Tasks.Single().Display);
        Assert.Equal("development", plan.Env["NODE_ENV"]);
        Assert.Equal(9000, plan.Port.First);
        Assert.Equal("dev.test", plan.Domain);
        Assert.Equal("myproj-amber-fox.dev.test", Single(plan).Hostname);
    }

    [Fact]
    public void BlankStringsAreTreatedAsAbsent()
    {
        var plan = Plan("""{ "image": "  ", "shell": "", "workdir": " " }""");

        Assert.Equal(SessionConfig.DefaultImage, plan.Image);
        Assert.Equal(SessionConfig.DefaultShell, plan.Shell);
        Assert.Equal(SessionConfig.DefaultWorkdir, plan.Workdir);
    }

    [Fact]
    public void PropertyNamesAreCaseInsensitive()
    {
        // A generated file should not fail on casing nobody agreed on.
        Assert.Equal("cased", Plan("""{ "Name": "cased" }""").Project);
    }

    [Fact]
    public void RejectsAPortThatIsNotAPort()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""{ "port": 70000 }"""));
        Assert.Contains("70000", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void BrokenJsonNamesTheFile()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("{ not json"));
        Assert.Contains(SessionConfig.FileName, e.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A repository that has adopted the convention gets the room's client as one more task.
    /// </summary>
    /// <remarks>
    /// In the plan rather than added by whoever starts the session, so that a
    /// restart — which re-resolves the plan from the file — keeps it, and so
    /// <c>--dry-run</c> shows it. With it comes <c>TZ</c>, so <c>date</c> in the
    /// instance files a line in the quarter hour the workstation is in.
    /// </remarks>
    [Fact]
    public void ARepositoryWithAContextDirectoryGetsTheRoom()
    {
        Directory.CreateDirectory(Path.Combine(_dir, ".context"));

        var plan = Plan("""{"name":"proj","tasks":{"web":"npm run dev"}}""");

        var room = Assert.Single(plan.Tasks, Agents.RoomClient.Is);
        Assert.True(room.IsInternal);
        Assert.Equal(plan.Portal.RoomToken, room.Env["ENVMUX_API_TOKEN"]);
        Assert.Equal("http://127.0.0.1:8078", room.Env["ENVMUX_API_URL"]);
        Assert.Equal(plan.Workdir, room.Workdir);
        Assert.StartsWith("ENVMUX", plan.Env["TZ"], StringComparison.Ordinal);

        // The declared task is still there and still first.
        Assert.Equal(["web", "room"], plan.Tasks.Select(t => t.Name));
    }

    [Fact]
    public void ARepositoryWithoutOneGetsNoRoom()
    {
        var plan = Plan("""{"name":"proj","tasks":{"web":"npm run dev"}}""");

        Assert.DoesNotContain(plan.Tasks, Agents.RoomClient.Is);
        Assert.False(plan.Env.ContainsKey("TZ"));
    }

    /// <summary>No token means nothing for the client to sign in with, so no client — and no crash; the session warns.</summary>
    [Fact]
    public void LeavesTheRoomOutWhenThePortalCannotAuthoriseIt()
    {
        Directory.CreateDirectory(Path.Combine(_dir, ".context"));

        Assert.DoesNotContain(Plan("""{"name":"proj","portal":{"token":false}}""").Tasks, Agents.RoomClient.Is);
        Assert.DoesNotContain(Plan("""{"name":"proj","portal":{"enabled":false}}""").Tasks, Agents.RoomClient.Is);
    }

    [Fact]
    public void RefusesAProjectWithARoomThatAlreadyHasATaskCalledRoom()
    {
        Directory.CreateDirectory(Path.Combine(_dir, ".context"));

        var e = Assert.Throws<ConfigException>(() => Plan("""{"name":"proj","tasks":{"room":"echo hi"}}"""));
        Assert.Contains("'room'", e.Message, StringComparison.Ordinal);
    }

    /// <summary>A configured <c>TZ</c> is the project's and wins over the derived one.</summary>
    [Fact]
    public void LeavesAConfiguredTimeZoneAloneForTheRoom()
    {
        Directory.CreateDirectory(Path.Combine(_dir, ".context"));

        Assert.Equal("Pacific/Auckland", Plan("""{"name":"proj","env":{"TZ":"Pacific/Auckland"}}""").Env["TZ"]);
    }

    private static Routing.RoutedEndpoint Single(SessionPlan plan) => Assert.Single(plan.Routes);
}
