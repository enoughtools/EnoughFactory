using System.Text.Json;

using Envmux.Config;
using Envmux.Portal;
using Envmux.Routing;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// What a <c>portal</c> block resolves to, and what an absent one does.
/// </summary>
/// <remarks>
/// Pure: no listener, no host, no browser. The defaults are the interesting
/// part — the portal is on and behind a token without anybody saying so, and
/// both of those are decisions somebody could regret silently.
/// </remarks>
public class PortalPlanTests
{
    private static PortalPlan Resolve(string json) =>
        PortalPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!.Portal);

    [Fact]
    public void IsOnAndBehindATokenWhenNothingIsSaid()
    {
        var portal = Resolve("{}");

        Assert.True(portal.Enabled);
        Assert.True(portal.WantsToken);
        Assert.False(portal.OpenOnStart);
    }

    [Fact]
    public void MintsTheTokenPerSession()
    {
        Assert.NotEqual(Resolve("{}").Token, Resolve("{}").Token);
    }

    [Fact]
    public void MintsNoTokenWhenThePortalIsOff()
    {
        // Nothing checks it, so there is no reason for it to exist.
        Assert.Equal("", Resolve("""{"portal":{"enabled":false}}""").Token);
    }

    [Fact]
    public void LetsTheTokenBeDeclined()
    {
        var portal = Resolve("""{"portal":{"token":false}}""");

        Assert.False(portal.WantsToken);
        Assert.Equal("http://127.0.0.1:8080/", portal.Url(8080));
    }

    [Fact]
    public void CarriesTheTokenInTheUrl()
    {
        var portal = Resolve("{}");

        Assert.Equal($"http://127.0.0.1:8080/?k={portal.Token}", portal.Url(8080));
    }

    [Fact]
    public void OpensABrowserOnlyWhenAsked()
    {
        Assert.True(Resolve("""{"portal":{"open":true}}""").OpenOnStart);
    }

    /// <summary>
    /// The portal cannot collide with a route, because it is not on the same
    /// machine as one.
    /// </summary>
    /// <remarks>
    /// It used to need a hostname no route could take, because routes and the
    /// page arrived on one listener and were told apart by <c>Host</c>. Now the
    /// page is on loopback and every route is a port on the instance's own
    /// address, so there is nothing to arrange.
    /// </remarks>
    [Fact]
    public void IsOnLoopbackAndNotOnTheInstance()
    {
        var routes = RouteTable.Build("proj", "sess", "envmux", new Dictionary<string, RouteConfig>
        {
            ["web"] = 5173,
        });

        Assert.Equal("127.0.0.1", PortalPlan.Loopback);
        Assert.DoesNotContain(routes, r => r.Hostname == PortalPlan.Loopback);
    }

    [Fact]
    public void RefusesAnInventedPortalField()
    {
        // The whole file behaves this way, and the portal is the block most
        // likely to be written from memory rather than from the schema.
        Assert.ThrowsAny<JsonException>(() =>
            JsonSerializer.Deserialize<SessionConfig>("""{"portal":{"auth":true}}""", SessionConfig.JsonOptions));
    }
}

/// <summary>
/// Which mounted tools get a button, and what opening one runs.
/// </summary>
/// <remarks>
/// Pure: no container, no engine, no host state. What is worth pinning down is
/// the distinction the buttons are built from — a tool you sit in front of
/// against state that exists so something else is authenticated — and the shape
/// of the command, which is composed into a shell and so is worth reading
/// rather than assuming.
/// </remarks>
public class PortalToolTests
{
    private static ToolMount Mount(string name) => new(name, $"/home/matt/.{name}", $".{name}");

    [Theory]
    [InlineData("claude")]
    [InlineData("codex")]
    [InlineData("gemini")]
    [InlineData("opencode")]
    public void OffersTheToolsThatAreASessionOfTheirOwn(string name) =>
        Assert.Equal([name], ToolMounts.Launchable([Mount(name)]));

    /// <summary>
    /// <c>gh</c> is mounted so that git is authenticated, not so that anybody
    /// looks at it. Running it with no arguments prints usage and exits, which
    /// is not worth a button.
    /// </summary>
    [Fact]
    public void OffersNothingForToolsThereIsNothingToOpen() =>
        Assert.Empty(ToolMounts.Launchable([Mount("gh")]));

    /// <summary>One tool can be several mounts, and is still one button.</summary>
    [Fact]
    public void NamesEachToolOnceHoweverManyMountsItHas()
    {
        var claude = new List<ToolMount>
        {
            new("claude", "/home/matt/.claude", ".claude"),
            new("claude", "/home/matt/.claude.json", ".claude.json"),
        };

        Assert.Equal(["claude"], ToolMounts.Launchable(claude));
    }

    [Fact]
    public void OrdersThemTheSameWayEverySession()
    {
        // Buttons that move between sessions are buttons that get clicked by
        // accident. The order is the known-tools table, not the mounts.
        IReadOnlyList<ToolMount> mounts = [Mount("opencode"), Mount("claude"), Mount("gemini")];

        Assert.Equal(["claude", "gemini", "opencode"], ToolMounts.Launchable(mounts));
    }

    [Fact]
    public void ExecsTheToolSoQuittingItEndsTheShell()
    {
        var script = PortalShell.LaunchScript("claude", "/bin/bash");

        Assert.Contains("exec claude", script, StringComparison.Ordinal);
        Assert.Contains("command -v claude", script, StringComparison.Ordinal);
    }

    /// <summary>
    /// The account envmux makes has no <c>.profile</c>, and a tool installed the
    /// way its own documentation says to lands in <c>~/.local/bin</c>.
    /// </summary>
    /// <remarks>
    /// Found by installing a stand-in tool there and watching the button report
    /// it missing. Claude Code's installer puts it exactly there, so without
    /// this the common case is the broken one.
    /// </remarks>
    [Fact]
    public void LooksWhereAToolActuallyInstallsItself()
    {
        Assert.StartsWith(
            "export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\"",
            PortalShell.LaunchScript("claude", "/bin/bash"),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// A tool whose state is mounted may still not be installed in the image.
    /// </summary>
    /// <remarks>
    /// Mounting says the tool is signed in on <em>this machine</em>. Whether the
    /// image has it is a different question, and the honest answer to it is a
    /// sentence and a shell rather than a terminal that closes a second after it
    /// opened.
    /// </remarks>
    [Fact]
    public void FallsBackToAShellWhenTheToolIsNotInTheImage()
    {
        var script = PortalShell.LaunchScript("codex", "/bin/sh");

        Assert.Contains("is not installed in this container", script, StringComparison.Ordinal);
        Assert.EndsWith("exec /bin/sh", script, StringComparison.Ordinal);
    }
}
