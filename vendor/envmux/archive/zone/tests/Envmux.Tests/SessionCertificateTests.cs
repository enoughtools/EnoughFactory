using System.Text.Json;

using Envmux.Config;
using Envmux.Host;
using Envmux.Routing;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// What a session's certificate turns into: a script that writes it into the
/// instance, an environment that points at it, and a route that says https.
/// </summary>
public class SessionCertificateTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static Authority.Leaf Leaf()
    {
        using var root = Authority.Create(Now);

        return Authority.Issue(root, ["myproj-feat-login.envmux"], ["10.100.0.4"], Now);
    }

    [Fact]
    public void TheScriptWritesEveryShapeOfTheSameKeyPair()
    {
        var script = SessionCertificate.Script(Leaf(), "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----", "matt");

        Assert.Contains(SessionCertificate.CertificateFile, script, StringComparison.Ordinal);
        Assert.Contains(SessionCertificate.KeyFile, script, StringComparison.Ordinal);
        Assert.Contains(SessionCertificate.ChainFile, script, StringComparison.Ordinal);
        Assert.Contains(SessionCertificate.BundleFile, script, StringComparison.Ordinal);
        Assert.Contains(SessionCertificate.RootFile, script, StringComparison.Ordinal);
    }

    [Fact]
    public void TheKeyIsReadableByTheSessionAccountAndNobodyElse()
    {
        // Everything that serves TLS in the instance runs as that account, so a
        // key only root can read is a key nothing can use.
        var script = SessionCertificate.Script(Leaf(), "pem", "matt");

        Assert.Contains($"chown -R 'matt:' '{SessionCertificate.Directory}'", script, StringComparison.Ordinal);
        Assert.Contains($"chmod 0600 '{SessionCertificate.KeyFile}'", script, StringComparison.Ordinal);
        Assert.Contains($"chmod 0644 '{SessionCertificate.CertificateFile}'", script, StringComparison.Ordinal);
    }

    [Fact]
    public void TheRootGoesIntoTheInstancesOwnTrustStoreToo()
    {
        // The half that is easy to forget: most of what a session serves over TLS
        // also talks to itself over TLS, and without this every one of those paths
        // needs validation turned off.
        var script = SessionCertificate.Script(Leaf(), "pem", "matt");

        Assert.Contains("/usr/local/share/ca-certificates/envmux-root.crt", script, StringComparison.Ordinal);
        Assert.Contains("update-ca-certificates", script, StringComparison.Ordinal);
    }

    [Fact]
    public void TheBundleCrossesAsBase64InLinesShortEnoughToSurviveAPty()
    {
        var script = SessionCertificate.Script(Leaf(), "pem", "matt");

        var body = script
            .Split("<<'ENVMUX_TLS_PFX'\n")[1]
            .Split("\nENVMUX_TLS_PFX")[0]
            .Split('\n');

        Assert.All(body, line => Assert.True(line.Length <= 76, $"{line.Length} characters"));
        Assert.True(body.Length > 1, "a few kilobytes should be more than one line");
    }

    [Fact]
    public void TheEnvironmentPointsAtWhatTheScriptWrote()
    {
        var leaf = Leaf();
        var environment = SessionCertificate.Environment(leaf);

        Assert.Equal(SessionCertificate.BundleFile, environment["ENVMUX_TLS_PFX"]);
        Assert.Equal(leaf.Password, environment["ENVMUX_TLS_PASSWORD"]);

        // The one framework-shaped exception, and the reason a .NET server in a
        // session serves this certificate with no code and no configuration.
        Assert.Equal(SessionCertificate.BundleFile, environment["Kestrel__Certificates__Default__Path"]);
        Assert.Equal(leaf.Password, environment["Kestrel__Certificates__Default__Password"]);
    }

    [Fact]
    public void NothingReplacesTheSystemBundleWholesale()
    {
        // SSL_CERT_FILE would point OpenSSL at the root alone and take every
        // public CA away from everything in the session at once. The script adds
        // the root to the system bundle instead, which is additive.
        Assert.DoesNotContain("SSL_CERT_FILE", SessionCertificate.Environment(Leaf()).Keys);
    }

    [Fact]
    public void TlsIsOnUnlessTheProjectSaysOtherwise()
    {
        Assert.True(Plan(new SessionConfig()).Tls);
        Assert.False(Plan(new SessionConfig { Tls = false }).Tls);
    }

    [Fact]
    public void ARouteSaysWhatItSpeaks()
    {
        var plan = Plan(new SessionConfig
        {
            Name = "myproj",
            Domain = "envmux",
            Routes = new Dictionary<string, RouteConfig>
            {
                ["vite"] = 5173,
                ["dashboard"] = new(15260, RouteConfig.Https),
                ["db"] = new(5432, "postgres"),
            },
        });

        Assert.Equal(
            [
                "https://localhost:15260/",
                "postgres://localhost:5432/",
                "http://localhost:5173/",
            ],
            plan.Routes.Select(r => r.Url));
    }

    [Theory]
    [InlineData("5173", 5173, "http")]
    [InlineData("""{ "port": 5173 }""", 5173, "http")]
    [InlineData("""{ "port": 15260, "tls": true }""", 15260, "https")]
    [InlineData("""{ "port": 15260, "tls": false }""", 15260, "http")]
    [InlineData("""{ "port": 5432, "scheme": "postgres" }""", 5432, "postgres")]
    [InlineData("""{ "port": 6379, "scheme": "REDIS" }""", 6379, "redis")]
    [InlineData("""{ "port": 5432, "scheme": "postgres://" }""", 5432, "postgres")]
    public void ARouteIsAPortOrAnObjectSayingMore(string json, int port, string scheme)
    {
        var route = JsonSerializer.Deserialize<RouteConfig>(json, SessionConfig.JsonOptions);

        Assert.NotNull(route);
        Assert.Equal(port, route.Port);
        Assert.Equal(scheme, route.Scheme);
    }

    [Theory]
    // Both would need a precedence rule, and neither order is more defensible.
    [InlineData("""{ "port": 1, "tls": true, "scheme": "https" }""")]
    // A route written as an object still has to say which port.
    [InlineData("""{ "tls": true }""")]
    // Not a URL scheme, so it would land as a broken link much later.
    [InlineData("""{ "port": 1, "scheme": "not a scheme" }""")]
    [InlineData("""{ "port": 1, "scheme": "9front" }""")]
    // A field a route does not have is a typo, not something to ignore.
    [InlineData("""{ "port": 1, "secure": true }""")]
    public void ARouteThatCannotBeMeantIsRefused(string json) =>
        Assert.ThrowsAny<JsonException>(
            () => JsonSerializer.Deserialize<RouteConfig>(json, SessionConfig.JsonOptions));

    [Fact]
    public void ARouteRoundTripsThroughTheShorthandItCameFrom()
    {
        foreach (var (route, expected) in new (RouteConfig, string)[]
                 {
                     (new RouteConfig(5173), "5173"),
                     (new RouteConfig(15260, RouteConfig.Https), """{"port":15260,"tls":true}"""),
                     (new RouteConfig(5432, "postgres"), """{"port":5432,"scheme":"postgres"}"""),
                 })
        {
            Assert.Equal(
                expected,
                JsonSerializer.Serialize(route, Compact));
        }
    }

    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    private static SessionPlan Plan(SessionConfig config) =>
        SessionPlan.Resolve(config, Directory.GetCurrentDirectory(), "sess");
}
