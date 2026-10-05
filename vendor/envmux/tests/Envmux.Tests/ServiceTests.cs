using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

public class ServicePlanTests
{
    private static ServicePlan Resolve(string json, string name = "db") =>
        ServicePlan.Resolve(
            name,
            System.Text.Json.JsonSerializer.Deserialize<ServiceConfig>(json, SessionConfig.JsonOptions)!,
            "proj",
            "amber-fox",
            "envmux");

    [Fact]
    public void APostgresNeedsOnlyItsType()
    {
        var db = Resolve("""{ "type": "postgres" }""");

        Assert.Equal("postgres:17-alpine", db.Image);
        Assert.Equal(5432, db.Port);
        Assert.Equal("postgres", db.User);
        Assert.NotEmpty(db.Password);
        Assert.Equal("proj-amber-fox-db", db.InstanceName);
        Assert.Equal("proj-amber-fox-db.envmux", db.Host);
    }

    [Fact]
    public void TheGeneratedPasswordReachesBothSides()
    {
        // The whole point of generating it here: the value the service
        // container starts with is the value the session container reads.
        var db = Resolve("""{ "type": "postgres", "user": "app", "database": "app" }""");

        Assert.Equal(db.Password, db.ServiceEnvironment()["POSTGRES_PASSWORD"]);
        Assert.Equal(db.Password, db.ReferenceEnvironment()["DB_PASSWORD"]);
        Assert.Contains(db.Password, db.ReferenceEnvironment()["ConnectionStrings__db"], StringComparison.Ordinal);
    }

    [Fact]
    public void EveryPasswordIsDifferent()
    {
        var passwords = Enumerable.Range(0, 20)
            .Select(_ => Resolve("""{ "type": "postgres" }""").Password)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(20, passwords.Count);
    }

    [Fact]
    public void AnExplicitPasswordIsKept()
    {
        var db = Resolve("""{ "type": "postgres", "password": "hunter2" }""");
        Assert.Equal("hunter2", db.Password);
    }

    [Fact]
    public void InjectsTheThreeShapesAConsumerMightRead()
    {
        var env = Resolve("""{ "type": "postgres", "user": "app", "database": "app" }""").ReferenceEnvironment();

        // .NET configuration binds this one on its own, and it is what Aspire
        // injects.
        Assert.Equal(
            $"Host=proj-amber-fox-db.envmux;Port=5432;Database=app;Username=app;Password={env["DB_PASSWORD"]}",
            env["ConnectionStrings__db"]);

        // Everything that is not .NET.
        Assert.Equal("proj-amber-fox-db.envmux", env["DB_HOST"]);
        Assert.Equal("5432", env["DB_PORT"]);
        Assert.Equal("app", env["DB_USER"]);
        Assert.Equal("app", env["DB_DATABASE"]);
        Assert.StartsWith("postgresql://app:", env["DB_URL"], StringComparison.Ordinal);

        // Aspire's service discovery shape.
        Assert.Equal("proj-amber-fox-db.envmux:5432", env["services__db__tcp__0"]);
    }

    [Fact]
    public void ACredentiallessServiceGetsNoCredentials()
    {
        var env = Resolve("""{ "type": "redis" }""", "cache").ReferenceEnvironment();

        Assert.Equal("proj-amber-fox-cache.envmux:6379", env["ConnectionStrings__cache"]);
        Assert.False(env.ContainsKey("CACHE_PASSWORD"));
    }

    [Fact]
    public void PasswordsInUrlsAreEscaped()
    {
        var db = Resolve("""{ "type": "postgres", "user": "a b", "password": "p@ss/word" }""");
        Assert.Contains("p%40ss%2Fword", db.Url(), StringComparison.Ordinal);
    }

    [Fact]
    public void PersistingBehindAGeneratedPasswordIsRefused()
    {
        // The data would be locked behind a password that changes next session.
        // Refusing beats letting somebody find out a week later.
        var e = Assert.Throws<ConfigException>(() => Resolve("""{ "type": "postgres", "persist": true }"""));
        Assert.Contains("password", e.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PersistingWithAnExplicitPasswordIsFine()
    {
        var db = Resolve("""{ "type": "postgres", "persist": true, "password": "hunter2" }""");

        Assert.True(db.Persist);
        Assert.Equal("proj-amber-fox-db-data", db.VolumeName);
        Assert.Equal("/var/lib/postgresql/data", db.DataPath);
    }

    [Fact]
    public void AnUnknownTypeSaysWhatIsAvailable()
    {
        var e = Assert.Throws<ConfigException>(() => Resolve("""{ "type": "cassandra" }"""));

        Assert.Contains("postgres", e.Message, StringComparison.Ordinal);
        Assert.Contains("container", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void APlainContainerNeedsAnImageAndAPort()
    {
        Assert.Throws<ConfigException>(() => Resolve("""{ "type": "container" }"""));
        Assert.Throws<ConfigException>(() => Resolve("""{ "type": "container", "image": "nats:2" }"""));

        var nats = Resolve("""{ "type": "container", "image": "nats:2", "port": 4222 }""", "queue");
        Assert.Equal("nats:2", nats.Image);
        Assert.Equal(4222, nats.Port);
    }
}
public class GeneratedTests
{
    [Fact]
    public void PasswordsAvoidCharactersThatBreakTheThingsTheyTravelThrough()
    {
        // A connection string, a shell, a YAML file, a URL. Length is free;
        // arguing with a quoting bug is not.
        for (var i = 0; i < 50; i++)
        {
            Assert.DoesNotContain(Generated.Password(), c => c is '"' or '\'' or '\\' or '$' or '`' or ' ');
        }
    }

    [Fact]
    public void EveryValueIsDifferent()
    {
        var values = Enumerable.Range(0, 200).Select(_ => Generated.Password()).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(200, values.Count);
    }

    [Theory]
    [InlineData("password")]
    [InlineData("token")]
    [InlineData("hex")]
    [InlineData("uuid")]
    public void EveryAdvertisedKindProducesSomething(string kind) =>
        Assert.NotEmpty(Generated.Of(kind, null));

    [Fact]
    public void LengthIsHonoured()
    {
        Assert.Equal(64, Generated.Of("password", 64).Length);
        Assert.Equal(16, Generated.Of("token", 16).Length);
    }

    [Fact]
    public void AnUnknownKindSaysWhatIsAvailable()
    {
        var e = Assert.Throws<ConfigException>(() => Generated.Of("rsa-keypair", null));
        Assert.Contains("password", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AZeroLengthValueIsRefused() =>
        Assert.Throws<ConfigException>(() => Generated.Of("password", 0));
}
