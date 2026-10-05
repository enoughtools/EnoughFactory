namespace Envmux.Config;

/// <summary>
/// A container the session depends on, rather than the one you work in.
/// </summary>
/// <remarks>
/// <para>
/// Modelled on how .NET Aspire does it: you name a service, envmux knows what
/// that kind of service needs, it generates the credentials, and the session
/// container is told how to reach it through environment variables it can
/// already read — <c>ConnectionStrings__&lt;name&gt;</c> and friends.
/// </para>
/// <para>
/// Deliberately not the archive's shared-service model. These are one session's
/// services on one session's network, not a namespace-wide Postgres with
/// per-workspace slices minted into it.
/// </para>
/// </remarks>
internal sealed record ServiceConfig
{
    /// <summary>What kind of service it is: <c>postgres</c>, <c>redis</c>, <c>mysql</c>, <c>mongo</c>, or <c>container</c>.</summary>
    public string? Type { get; init; }

    /// <summary>Override the image the type would pick.</summary>
    public string? Image { get; init; }

    /// <summary>Override the port the type listens on.</summary>
    public int? Port { get; init; }

    /// <summary>The database or namespace to create. Defaults to the service name.</summary>
    public string? Database { get; init; }

    /// <summary>The account to connect as. Defaults to the type's own convention.</summary>
    public string? User { get; init; }

    /// <summary>
    /// A literal password, when you need one that survives the session.
    /// </summary>
    /// <remarks>
    /// Absent, envmux generates one per session and never writes it down. Set
    /// this — alongside <see cref="Persist"/> — when you want a database you can
    /// come back to, and keep it out of a committed file.
    /// </remarks>
    public string? Password { get; init; }

    /// <summary>
    /// Give the service a named volume, so its data outlives the session.
    /// </summary>
    /// <remarks>
    /// Only useful with an explicit <see cref="Password"/>: a generated one
    /// changes every run, and the data it protected becomes unreachable.
    /// </remarks>
    public bool? Persist { get; init; }

    /// <summary>Extra environment for the service container.</summary>
    public Dictionary<string, string>? Env { get; init; }
}

/// <summary>How to generate one environment variable.</summary>
/// <remarks>
/// Written as either <c>"password"</c> or <c>{ "kind": "password", "length": 48 }</c>.
/// The short form is what almost everyone wants, so it is the one that reads
/// well; the long form exists for when the length matters.
/// </remarks>
[System.Text.Json.Serialization.JsonConverter(typeof(GenerateConfigConverter))]
internal sealed record GenerateConfig
{
    public string? Kind { get; init; }

    public int? Length { get; init; }
}

/// <summary>Reads both the short and long forms of a <c>generate</c> entry.</summary>
internal sealed class GenerateConfigConverter : System.Text.Json.Serialization.JsonConverter<GenerateConfig>
{
    public override GenerateConfig? Read(
        ref System.Text.Json.Utf8JsonReader reader,
        Type typeToConvert,
        System.Text.Json.JsonSerializerOptions options)
    {
        if (reader.TokenType == System.Text.Json.JsonTokenType.String)
        {
            return new GenerateConfig { Kind = reader.GetString() };
        }

        if (reader.TokenType != System.Text.Json.JsonTokenType.StartObject)
        {
            throw new System.Text.Json.JsonException(
                "a 'generate' entry is a kind like \"password\", or { \"kind\": \"password\", \"length\": 48 }");
        }

        string? kind = null;
        int? length = null;

        while (reader.Read() && reader.TokenType != System.Text.Json.JsonTokenType.EndObject)
        {
            if (reader.TokenType != System.Text.Json.JsonTokenType.PropertyName)
            {
                continue;
            }

            var property = reader.GetString();
            reader.Read();

            if (string.Equals(property, "kind", StringComparison.OrdinalIgnoreCase))
            {
                kind = reader.GetString();
            }
            else if (string.Equals(property, "length", StringComparison.OrdinalIgnoreCase))
            {
                length = reader.GetInt32();
            }
            else
            {
                reader.Skip();
            }
        }

        return new GenerateConfig { Kind = kind, Length = length };
    }

    public override void Write(
        System.Text.Json.Utf8JsonWriter writer,
        GenerateConfig value,
        System.Text.Json.JsonSerializerOptions options)
    {
        if (value.Length is null)
        {
            writer.WriteStringValue(value.Kind);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("kind", value.Kind);
        writer.WriteNumber("length", value.Length.Value);
        writer.WriteEndObject();
    }
}

/// <summary>
/// What envmux knows about a kind of service without being told.
/// </summary>
/// <param name="Image">The image to run.</param>
/// <param name="Port">The port it listens on.</param>
/// <param name="User">The account it creates by convention.</param>
/// <param name="Scheme">The URL scheme for its connection string.</param>
/// <param name="NeedsCredentials">Whether it has a password at all.</param>
internal sealed record ServiceKind(
    string Image,
    int Port,
    string User,
    string Scheme,
    bool NeedsCredentials = true)
{
    /// <summary>
    /// The service types envmux ships knowledge of.
    /// </summary>
    /// <remarks>
    /// A short list on purpose. <c>container</c> is the escape hatch: any image,
    /// any port, no assumptions — which is what stops this table from having to
    /// grow every time somebody needs something not on it.
    /// </remarks>
    public static readonly IReadOnlyDictionary<string, ServiceKind> Known =
        new Dictionary<string, ServiceKind>(StringComparer.OrdinalIgnoreCase)
        {
            ["postgres"] = new("postgres:17-alpine", 5432, "postgres", "postgresql"),
            ["mysql"] = new("mysql:8", 3306, "root", "mysql"),
            ["mariadb"] = new("mariadb:11", 3306, "root", "mysql"),
            ["mongo"] = new("mongo:7", 27017, "root", "mongodb"),
            ["redis"] = new("redis:7-alpine", 6379, "default", "redis", NeedsCredentials: false),
            ["container"] = new("", 0, "", "tcp", NeedsCredentials: false),
        };

    public static ServiceKind Resolve(string name, string? type)
    {
        var key = string.IsNullOrWhiteSpace(type) ? "container" : type.Trim();

        if (Known.TryGetValue(key, out var kind))
        {
            return kind;
        }

        throw new ConfigException(
            $"service '{name}' has type '{key}', which envmux does not know. " +
            $"Try one of {string.Join(", ", Known.Keys)} — or 'container' with an explicit image and port.");
    }
}
