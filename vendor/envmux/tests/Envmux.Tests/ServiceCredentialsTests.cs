using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// A kept service, and the password it was created with.
/// </summary>
/// <remarks>
/// The bug this is about: a generated password is generated per session, and a
/// service instance is kept between them. So the second session invents a new
/// one while Postgres still has the first baked into its data directory, and
/// everything that connects fails with <c>password authentication failed for
/// user "footprint"</c> — on a service envmux had just reported as up, with
/// credentials it had just put in the environment. It worked on the first run of
/// any project and never again.
/// </remarks>
public class ServiceCredentialsTests
{
    private static ServicePlan Planned(string password = "second-session-password") => new()
    {
        Name = "db",
        Type = "postgres",
        Kind = ServiceKind.Known["postgres"],
        Image = "postgres:17",
        Port = 5432,
        User = "footprint",
        Password = password,
        Database = "footprint",
        Persist = false,
        ExtraEnv = new Dictionary<string, string>(StringComparer.Ordinal),
        InstanceName = "footprint-dev-db",
        Host = "footprint-dev-db.envmux",
    };

    /// <summary>What the instance was actually created with.</summary>
    private static Dictionary<string, string> Created(string password) =>
        new(StringComparer.Ordinal)
        {
            ["environment.POSTGRES_USER"] = "footprint",
            ["environment.POSTGRES_PASSWORD"] = password,
            ["environment.POSTGRES_DB"] = "footprint",
            ["user.envmux.project"] = "footprint",
        };

    /// <summary>The instance wins, because its data directory cannot be argued with.</summary>
    [Fact]
    public void AKeptServiceKeepsThePasswordItWasCreatedWith()
    {
        var actual = Planned().AsCreated(Created("first-session-password"));

        Assert.Equal("first-session-password", actual.Password);
        Assert.Contains("Password=first-session-password", actual.ConnectionString(), StringComparison.Ordinal);
        Assert.Equal("first-session-password", actual.ReferenceEnvironment()["DB_PASSWORD"]);
    }

    /// <summary>And when they already agree, nothing changes.</summary>
    [Fact]
    public void AMatchingPasswordIsNotAChange()
    {
        var planned = Planned("same");

        Assert.Same(planned, planned.AsCreated(Created("same")));
    }

    /// <summary>
    /// An instance that recorded nothing keeps the plan.
    /// </summary>
    /// <remarks>
    /// One made by an older envmux, or a service kind that stores no
    /// credentials. The same behaviour as before this existed, which is the
    /// right fallback: inventing a correction from an absent value would be
    /// worse than the bug.
    /// </remarks>
    [Fact]
    public void AnInstanceThatRecordedNothingKeepsThePlan()
    {
        var planned = Planned();

        Assert.Same(planned, planned.AsCreated(new Dictionary<string, string>(StringComparer.Ordinal)));
    }

    /// <summary>The user and database come back too, not only the password.</summary>
    [Fact]
    public void EveryCredentialComesFromTheInstance()
    {
        var config = Created("older");
        config["environment.POSTGRES_USER"] = "olduser";
        config["environment.POSTGRES_DB"] = "olddb";

        var actual = Planned().AsCreated(config);

        Assert.Equal("olduser", actual.User);
        Assert.Equal("olddb", actual.Database);
        Assert.Equal("older", actual.Password);

        // And the URL that everything not-.NET reads is rebuilt from them.
        Assert.Contains("olduser:older@", actual.Url(), StringComparison.Ordinal);
    }
}
