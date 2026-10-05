using Envmux.Config;
using Envmux.Portal;
using Envmux.Routing;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The whole of the routing, now that there is no proxy in it. An instance has
/// an address, dnsmasq answers for its name, and a route is a port — so what is
/// left to get right is the name.
/// </summary>
public class RouteTableTests
{
    private static readonly string[] FourSessions =
        ["amber-fox", "jade-lynx", "neon-raven", "solar-ibex"];

    [Fact]
    public void TheHostnameIsTheInstanceNameInTheZone() =>
        Assert.Equal("myproj-amber-fox.envmux", RouteTable.Hostname("myproj", "amber-fox", "envmux"));

    [Fact]
    public void TheInstanceNameIsTheFirstLabelOfIt()
    {
        // One string doing two jobs, and it has to be exactly one string: Incus
        // registers an instance in the bridge's DNS under its own name, so the
        // name being the label is what makes the hostname resolve at all.
        Assert.Equal("myproj-amber-fox", RouteTable.InstanceName("myproj", "amber-fox"));
        Assert.StartsWith(
            RouteTable.InstanceName("myproj", "amber-fox") + ".",
            RouteTable.Hostname("myproj", "amber-fox", "envmux"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void SlugsEveryLabel() =>
        Assert.Equal("my-proj-feat-login.envmux", RouteTable.Hostname("My Proj", "feat/login", "envmux"));

    [Fact]
    public void ConcurrentSessionsGetDistinctNames()
    {
        // Four sessions in one directory is the design target, and they are four
        // machines rather than four port allocations.
        var hosts = FourSessions.Select(s => RouteTable.Hostname("proj", s, "envmux")).ToList();

        Assert.Equal(4, hosts.Distinct().Count());
    }

    [Fact]
    public void AServiceHangsOffTheSessionsName() =>
        Assert.Equal("proj-sess-db", RouteTable.ServiceInstanceName("proj", "sess", "db"));

    [Theory]
    [InlineData("ENVMUX", "n-s.envmux")]
    [InlineData("envmux.", "n-s.envmux")]
    [InlineData(".dev.test", "n-s.dev.test")]
    public void NormalisesTheDomain(string domain, string expected) =>
        Assert.Equal(expected, RouteTable.Hostname("n", "s", domain));

    [Fact]
    public void OrdersRoutesByName()
    {
        var routes = RouteTable.Build("p", "s", "envmux", new Dictionary<string, RouteConfig>
        {
            ["vite"] = 5173,
            ["api"] = 3000,
            ["docs"] = 4000,
        });

        Assert.Equal(["api", "docs", "vite"], routes.Select(r => r.Name));
    }

    [Fact]
    public void EveryRouteSharesTheOneHostname()
    {
        // The thing the whole design turns on. Two servers on one machine differ
        // by port, and that is now also how they differ from outside.
        var routes = RouteTable.Build("p", "s", "envmux", new Dictionary<string, RouteConfig>
        {
            ["api"] = 3000,
            ["db"] = 5432,
        });

        Assert.Equal(["p-s.envmux", "p-s.envmux"], routes.Select(r => r.Hostname));
        Assert.Equal(["http://localhost:3000/", "http://localhost:5432/"], routes.Select(r => r.Url));
    }

    [Fact]
    public void TwoSessionsCanBothBind3000()
    {
        // Both are localhost:3000, and that is fine: each session has a browser
        // of its own whose localhost is its own instance. Neither had to move
        // off the port the server actually listens on, and they are still two
        // machines with two names.
        var one = RouteTable.Build("p", "one", "envmux", new Dictionary<string, RouteConfig> { ["api"] = 3000 })[0];
        var two = RouteTable.Build("p", "two", "envmux", new Dictionary<string, RouteConfig> { ["api"] = 3000 })[0];

        Assert.Equal(one.Url, two.Url);
        Assert.NotEqual(one.Hostname, two.Hostname);
        Assert.Equal(3000, one.Port);
        Assert.Equal(3000, two.Port);
    }

    [Fact]
    public void TwoRoutesOnOnePortAreARefusal()
    {
        // With one address per session there is nothing left to tell them apart,
        // so this was a mistake in the declaration rather than a routing feature.
        var e = Assert.Throws<ConfigException>(() =>
            RouteTable.Build("p", "s", "envmux", new Dictionary<string, RouteConfig>
            {
                ["api"] = 3000,
                ["web"] = 3000,
            }));

        Assert.Contains("3000", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NoRoutesIsNotAnError()
    {
        Assert.Empty(RouteTable.Build("p", "s", "envmux", null));
        Assert.Empty(RouteTable.Build("p", "s", "envmux", new Dictionary<string, RouteConfig>()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65536)]
    public void RejectsPortsThatAreNotPorts(int port)
    {
        var e = Assert.Throws<ConfigException>(() =>
            RouteTable.Build("p", "s", "envmux", new Dictionary<string, RouteConfig> { ["bad"] = port }));

        Assert.Contains("bad", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheUrlIsTheRealPortOnLocalhost()
    {
        // No claimed port and nothing to translate: the port the server bound,
        // on the name that is the instance in the session's browser.
        Assert.Equal("http://localhost:5173/", new RoutedEndpoint("vite", 5173, "p-s.envmux").Url);
    }

    [Fact]
    public void TheDelimiterIsTlsSafe()
    {
        // Underscores are not legal in DNS hostnames, and this string is also an
        // Incus instance name, which permits exactly the same alphabet.
        Assert.Equal('-', RouteTable.Delimiter);
        Assert.DoesNotContain('_', RouteTable.Hostname("a_b", "c_d", "envmux"));
    }
}

/// <summary>
/// What the routes pane and the page's sidebar are handed.
/// </summary>
/// <remarks>
/// The portal is the odd one out: a page about the session, on loopback, rather
/// than something running in the instance. It is listed anyway, because it is
/// still a URL somebody wants to open.
/// </remarks>
public class RouteListingTests
{
    private static SessionPlan Plan(bool portal = true, bool token = true, params (string Name, int Port)[] routes)
    {
        var config = new SessionConfig
        {
            Name = "proj",
            Domain = "envmux",
            Portal = new PortalConfig { Enabled = portal, Token = token },
            Routes = routes.Length == 0 ? null : routes.ToDictionary(r => r.Name, r => (RouteConfig)r.Port),
        };

        return SessionPlan.Resolve(config, Directory.GetCurrentDirectory(), "sess");
    }

    private static SessionPlan Two() => Plan(routes: [("api", 3000), ("web", 5173)]);

    [Fact]
    public void ListsThePortalFirstAndCallsItEnvmux()
    {
        var listed = RouteListing.Build(Two(), 8080, "10.100.0.2");

        Assert.Equal(["envmux", "api", "web"], listed.Select(r => r.Name));
        Assert.True(listed[0].IsPortal);
        Assert.False(listed[1].IsPortal);
    }

    [Fact]
    public void CarriesTheKeySoTheLinkOpens()
    {
        var plan = Plan();
        var listed = RouteListing.Build(plan, 8080, "10.100.0.2");

        Assert.Equal($"http://127.0.0.1:8080/?k={plan.Portal.Token}", listed[0].Url);
        Assert.Equal("127.0.0.1", listed[0].Hostname);
    }

    [Fact]
    public void HasNoKeyToCarryWhenThePortalWantsNone() =>
        Assert.Equal("http://127.0.0.1:8080/", RouteListing.Build(Plan(token: false), 8080, "10.100.0.2")[0].Url);

    /// <summary>The portal is on loopback, not on the instance.</summary>
    [Fact]
    public void GivesThePortalNoPortOnTheInstance() =>
        Assert.Equal(0, RouteListing.Build(Plan(), 8080, "10.100.0.2").Single().Port);

    [Fact]
    public void KeepsTheRoutesAsTheyWere()
    {
        var listed = RouteListing.Build(Two(), 8080, "10.100.0.2");

        Assert.Equal("http://localhost:3000/", listed[1].Url);
        Assert.Equal(3000, listed[1].Port);
    }

    [Fact]
    public void ListsNoPortalWhenThereIsNone() =>
        Assert.DoesNotContain(RouteListing.Build(Plan(portal: false), 8080, "10.100.0.2"), r => r.IsPortal);

    /// <summary>
    /// No port means nothing has claimed one yet, and a URL naming port zero is
    /// a link that goes nowhere.
    /// </summary>
    [Fact]
    public void ListsNoPortalBeforeThereIsAListener() =>
        Assert.DoesNotContain(RouteListing.Build(Plan(), 0, "10.100.0.2"), r => r.IsPortal);

    /// <summary>
    /// And no address means the instance has not come up, so every routed name
    /// is one that does not resolve yet.
    /// </summary>
    [Fact]
    public void ListsNoRoutesBeforeThereIsAnAddress() =>
        Assert.Single(RouteListing.Build(Two(), 8080, ""));
}
