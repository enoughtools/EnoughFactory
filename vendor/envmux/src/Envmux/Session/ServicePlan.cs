using System.Globalization;

using Envmux.Config;
using Envmux.Routing;

namespace Envmux.Session;

/// <summary>
/// A service, resolved: its image, its credentials, and the environment both
/// sides need to find each other.
/// </summary>
internal sealed record ServicePlan
{
    /// <summary>The name it was given in <c>services</c>, and its DNS alias on the network.</summary>
    public required string Name { get; init; }

    /// <summary>The kind it was declared as, lowercased. Drives every per-type decision below.</summary>
    public required string Type { get; init; }

    public required ServiceKind Kind { get; init; }
    public required string Image { get; init; }
    public required int Port { get; init; }
    public required string User { get; init; }
    public required string Password { get; init; }
    public required string Database { get; init; }
    public required bool Persist { get; init; }
    public required IReadOnlyDictionary<string, string> ExtraEnv { get; init; }

    /// <summary>The instance's name, which is also the first label of its hostname.</summary>
    public required string InstanceName { get; init; }

    /// <summary>
    /// Where the session reaches it: a name in the zone, resolving to its own address.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Not a bare alias on a private network any more — a real name that
    /// resolves from Windows as well as from the session, because everything is
    /// on the one bridge and dnsmasq answers for all of it. So the connection
    /// string envmux writes into the session's environment is also the one you
    /// can paste into a database client on the workstation, which was never true
    /// before.
    /// </para>
    /// <para>
    /// And two sessions in one directory both get a Postgres on 5432, because
    /// they are two machines. That is the whole of what the port arithmetic used
    /// to be for.
    /// </para>
    /// </remarks>
    public required string Host { get; init; }

    /// <summary>The storage volume its data lives in, when it is meant to survive.</summary>
    public string? VolumeName => Persist ? $"{InstanceName}-data" : null;

    /// <summary>
    /// The registry the image comes from, for an OCI application container.
    /// </summary>
    /// <remarks>
    /// A service is published as a Docker image and there is no reason to make
    /// anybody find a system-container equivalent — Incus runs OCI images as
    /// application containers directly, so <c>postgres:17</c> means what it has
    /// always meant.
    /// </remarks>
    public static string Registry => "https://docker.io";

    public static ServicePlan Resolve(
        string name,
        ServiceConfig config,
        string project,
        string session,
        string domain)
    {
        var type = string.IsNullOrWhiteSpace(config.Type) ? "container" : config.Type.Trim().ToLowerInvariant();
        var kind = ServiceKind.Resolve(name, config.Type);
        var image = Blank(config.Image) ?? kind.Image;

        if (image.Length == 0)
        {
            throw new ConfigException($"service '{name}' has no image — a 'container' service needs one");
        }

        var port = config.Port ?? kind.Port;
        if (port is < 1 or > 65535)
        {
            throw new ConfigException(
                $"service '{name}' has port {port}, which is not a port — a 'container' service needs one declared");
        }

        if (config.Persist == true && config.Password is null && kind.NeedsCredentials)
        {
            // Persisting data behind a password that changes every session
            // produces a volume nobody can open again. Better to refuse than to
            // let someone discover it a week later.
            throw new ConfigException(
                $"service '{name}' sets persist but has no password. A generated password changes every " +
                "session, so the data it protected would be unreachable. Set 'password' explicitly.");
        }

        return new ServicePlan
        {
            Name = name,
            Type = type,
            Kind = kind,
            Image = image,
            Port = port,
            User = Blank(config.User) ?? kind.User,
            Password = Blank(config.Password) ?? (kind.NeedsCredentials ? Generated.Password() : ""),
            Database = Blank(config.Database) ?? Slug.From(name),
            Persist = config.Persist ?? false,
            ExtraEnv = config.Env ?? [],
            InstanceName = RouteTable.ServiceInstanceName(project, session, name),
            Host = $"{RouteTable.ServiceInstanceName(project, session, name)}.{domain}",
        };

        static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }

    /// <summary>
    /// The environment the <em>service</em> container needs to start up as
    /// configured.
    /// </summary>
    /// <summary>
    /// The same plan, with the credentials an existing instance was built with.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A generated password is generated per session, and a service instance is
    /// kept between them. So the second session invents a new password while the
    /// database still has the first one baked into its data directory, and
    /// everything that connects fails with
    /// <c>password authentication failed for user "footprint"</c> — on a service
    /// envmux had just reported as up, with credentials it had just put in the
    /// environment.
    /// </para>
    /// <para>
    /// The instance is the authority, because it is the thing that cannot be
    /// changed: the password it was created with is in its data directory. So
    /// the plan is corrected from it rather than the other way round.
    /// </para>
    /// <para>
    /// Only what the instance actually carries. An instance from an older envmux
    /// that never recorded a user keeps the planned one, which is the same
    /// behaviour as before and no worse.
    /// </para>
    /// </remarks>
    /// <param name="config">The existing instance's config, keys and all.</param>
    public ServicePlan AsCreated(IReadOnlyDictionary<string, string> config)
    {
        var plan = this;

        foreach (var (key, value) in ServiceEnvironment())
        {
            if (!config.TryGetValue($"environment.{key}", out var actual) ||
                actual.Equals(value, StringComparison.Ordinal))
            {
                continue;
            }

            plan = key switch
            {
                "POSTGRES_PASSWORD" or "MYSQL_ROOT_PASSWORD" or "MONGO_INITDB_ROOT_PASSWORD"
                    => plan with { Password = actual },
                "POSTGRES_USER" or "MONGO_INITDB_ROOT_USERNAME"
                    => plan with { User = actual },
                "POSTGRES_DB" or "MYSQL_DATABASE" or "MONGO_INITDB_DATABASE"
                    => plan with { Database = actual },
                _ => plan,
            };
        }

        return plan;
    }

    public IReadOnlyDictionary<string, string> ServiceEnvironment()
    {
        var env = new Dictionary<string, string>(StringComparer.Ordinal);

        switch (Type)
        {
            case "postgres":
                env["POSTGRES_USER"] = User;
                env["POSTGRES_PASSWORD"] = Password;
                env["POSTGRES_DB"] = Database;
                break;

            case "mysql":
            case "mariadb":
                env["MYSQL_ROOT_PASSWORD"] = Password;
                env["MYSQL_DATABASE"] = Database;
                break;

            case "mongo":
                env["MONGO_INITDB_ROOT_USERNAME"] = User;
                env["MONGO_INITDB_ROOT_PASSWORD"] = Password;
                env["MONGO_INITDB_DATABASE"] = Database;
                break;

            default:
                break;
        }

        foreach (var (key, value) in ExtraEnv)
        {
            env[key] = value;
        }

        return env;
    }

    /// <summary>
    /// The environment the <em>session</em> container is given so it can find
    /// this service.
    /// </summary>
    /// <remarks>
    /// Three shapes of the same fact, because three kinds of consumer read
    /// three different things:
    /// <list type="bullet">
    /// <item><c>ConnectionStrings__&lt;name&gt;</c> — what .NET configuration binds
    /// automatically, and what Aspire injects.</item>
    /// <item><c>&lt;NAME&gt;_HOST</c>, <c>_PORT</c>, <c>_USER</c>, <c>_PASSWORD</c>,
    /// <c>_DATABASE</c>, <c>_URL</c> — what everything that is not .NET reads.</item>
    /// <item><c>services__&lt;name&gt;__tcp__0</c> — Aspire's service discovery
    /// shape, for anything already speaking it.</item>
    /// </list>
    /// The password is the same string in all of them and the same string the
    /// service container was started with, which is the point of generating it
    /// once, here.
    /// </remarks>
    public IReadOnlyDictionary<string, string> ReferenceEnvironment()
    {
        var prefix = Slug.From(Name).Replace('-', '_').ToUpperInvariant();
        var port = Port.ToString(CultureInfo.InvariantCulture);

        var env = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [$"ConnectionStrings__{Name}"] = ConnectionString(),
            [$"services__{Name}__tcp__0"] = $"{Host}:{port}",
            [$"{prefix}_HOST"] = Host,
            [$"{prefix}_PORT"] = port,
            [$"{prefix}_URL"] = Url(),
        };

        if (Kind.NeedsCredentials)
        {
            env[$"{prefix}_USER"] = User;
            env[$"{prefix}_PASSWORD"] = Password;
            env[$"{prefix}_DATABASE"] = Database;
        }

        return env;
    }

    /// <summary>The connection string in the form the service's own drivers expect.</summary>
    public string ConnectionString() => Type switch
    {
        "postgres" =>
            $"Host={Host};Port={Port};Database={Database};Username={User};Password={Password}",
        "mysql" or "mariadb" =>
            $"Server={Host};Port={Port};Database={Database};User ID={User};Password={Password}",
        "mongo" => Url(),
        "redis" => $"{Host}:{Port}",
        _ => $"{Host}:{Port}",
    };

    /// <summary>The same thing as a URL, which most non-.NET clients would rather have.</summary>
    public string Url() => Kind.NeedsCredentials
        ? $"{Kind.Scheme}://{Uri.EscapeDataString(User)}:{Uri.EscapeDataString(Password)}@{Host}:{Port}/{Database}"
        : $"{Kind.Scheme}://{Host}:{Port}";

    /// <summary>Where the image keeps its data, for the persist volume.</summary>
    public string? DataPath => Type switch
    {
        "postgres" => "/var/lib/postgresql/data",
        "mysql" or "mariadb" => "/var/lib/mysql",
        "mongo" => "/data/db",
        "redis" => "/data",
        _ => null,
    };
}
