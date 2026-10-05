using System.Text.Json;

using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

public class PortSpecTests
{
    private static PortSpec Parse(string json) =>
        JsonSerializer.Deserialize<PortSpec>(json, SessionConfig.JsonOptions)!;

    [Fact]
    public void ABareNumberStillWalksUpward()
    {
        // A single port with no room to move would fail the moment a second
        // session started.
        var spec = Parse("8080");

        Assert.Equal(8080, spec.First);
        Assert.False(spec.IsRange);
        Assert.Equal([8080, 8081, 8082], spec.Candidates().Take(3));
        Assert.Equal(PortSpec.DefaultWalk, spec.Count);
    }

    [Fact]
    public void ARangeIsClaimedWithin()
    {
        var spec = Parse("[2050, 2060]");

        Assert.Equal(2050, spec.First);
        Assert.Equal(2060, spec.Last);
        Assert.True(spec.IsRange);
        Assert.Equal(11, spec.Count);
        Assert.Equal(11, spec.Candidates().Count());
        Assert.Equal(2060, spec.Candidates().Last());
    }

    [Fact]
    public void ARangeDoesNotWalkPastItsEnd()
    {
        // The point of naming a range: a firewall rule or a bookmark can rely
        // on it, which it could not if a busy range spilled over.
        Assert.DoesNotContain(2061, Parse("[2050, 2060]").Candidates());
    }

    [Fact]
    public void AOneElementRangeIsAPortSomebodyMeantToWiden() =>
        Assert.Equal(3000, Parse("[3000]").First);

    [Fact]
    public void NeverWrapsPastTheLastPort() =>
        Assert.Equal([65534, 65535], Parse("[65534, 70000]").Candidates());

    [Theory]
    [InlineData("\"8080\"")]
    [InlineData("[1, 2, 3]")]
    [InlineData("[\"a\", \"b\"]")]
    [InlineData("{}")]
    public void RejectsWhatIsNotAPortOrARange(string json) =>
        Assert.Throws<JsonException>(() => Parse(json));

    [Fact]
    public void ABackwardsRangeIsRefused()
    {
        var e = Assert.Throws<ConfigException>(() => Parse("[2060, 2050]").Validate());
        Assert.Contains("before it starts", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnOutOfRangePortIsRefused() =>
        Assert.Throws<ConfigException>(() => Parse("[70000, 70010]").Validate());

    [Fact]
    public void RoundTrips()
    {
        // A bare port writes back as a number and a range as an array, so a
        // config envmux generates reads the way the one you wrote does.
        Assert.Equal("8080", JsonSerializer.Serialize(PortSpec.Single(8080), SessionConfig.JsonOptions));

        var range = JsonSerializer.Serialize(PortSpec.Range(2050, 2060), SessionConfig.JsonOptions);
        Assert.Equal("[2050,2060]", string.Concat(range.Where(c => !char.IsWhiteSpace(c))));
        Assert.Equal(PortSpec.Range(2050, 2060), Parse(range));
    }

    [Fact]
    public void ReadsBothFormsFromAConfig()
    {
        var bare = SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>("""{ "port": 9000 }""", SessionConfig.JsonOptions)!,
            Path.GetTempPath(),
            "s");

        var ranged = SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>("""{ "port": [2050, 2060] }""", SessionConfig.JsonOptions)!,
            Path.GetTempPath(),
            "s");

        Assert.False(bare.Port.IsRange);
        Assert.Equal(9000, bare.Port.First);
        Assert.True(ranged.Port.IsRange);
        Assert.Equal("2050-2060", ranged.Port.ToString());
    }
}

public class GenerateAndSocketTests
{
    private static SessionPlan Plan(string json) =>
        SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Path.Combine(Path.GetTempPath(), "proj"),
            "amber-fox");

    [Fact]
    public void GeneratesTheShortForm()
    {
        var env = Plan("""{ "generate": { "SECRET": "password" } }""").Env;

        Assert.True(env.ContainsKey("SECRET"));
        Assert.Equal(Generated.DefaultPasswordLength, env["SECRET"].Length);
    }

    [Fact]
    public void GeneratesTheLongForm()
    {
        var env = Plan("""{ "generate": { "TOKEN": { "kind": "token", "length": 24 } } }""").Env;
        Assert.Equal(24, env["TOKEN"].Length);
    }

    [Fact]
    public void TheDeclarationWinsOverWhatWasGenerated()
    {
        // The escape hatch when a generated name collides with something real.
        var env = Plan("""
            {
              "generate": { "SECRET": "password" },
              "env": { "SECRET": "i-said-so" }
            }
            """).Env;

        Assert.Equal("i-said-so", env["SECRET"]);
    }

    [Fact]
    public void ServiceReferencesLoseToBothOfThem()
    {
        var env = Plan("""
            {
              "services": { "db": { "type": "postgres" } },
              "env": { "DB_HOST": "somewhere-else" }
            }
            """).Env;

        Assert.Equal("somewhere-else", env["DB_HOST"]);
    }

    [Fact]
    public void AGenerateEntryWithNoKindIsRefused()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""{ "generate": { "X": { "length": 8 } } }"""));
        Assert.Contains("X", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheBootstrapMakesAnAccountThatIsNotRoot()
    {
        // The whole of what it still has to do. Matching the host's uid went
        // with the bind mount: nothing the session writes is read back through
        // a host filesystem, so there is no ownership to line up.
        var script = Bootstrap.Script("matt", "/work", "/myproj_amber-fox");

        Assert.Contains("useradd -m", script, StringComparison.Ordinal);
        Assert.Contains("'matt'", script, StringComparison.Ordinal);
        Assert.DoesNotContain("root", script.Split('\n')[1], StringComparison.Ordinal);
    }

    [Fact]
    public void ServicesGetInstancesOfTheirOwn()
    {
        // No shared private network, and nothing published: a service is another
        // machine with a name that resolves, so its address is one a database
        // client on the workstation can use too.
        var plan = Plan("""{ "services": { "db": { "type": "postgres" } } }""");
        var db = plan.Services.Single();

        Assert.Equal($"{plan.InstanceName}-db", db.InstanceName);
        Assert.Equal($"{db.InstanceName}.{plan.Domain}", db.Host);
        Assert.Equal(5432, db.Port);
    }
}
