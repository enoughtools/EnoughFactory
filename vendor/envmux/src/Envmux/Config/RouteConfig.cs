using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// A route: the port a server binds, and what it speaks on it.
/// </summary>
/// <remarks>
/// <para>
/// Written as a bare port, which is what almost every route is:
/// </para>
/// <code>
/// { "routes": { "vite": 5173 } }
/// </code>
/// <para>
/// or as an object when the server on that port is not a plain HTTP one:
/// </para>
/// <code>
/// { "routes": { "dashboard": { "port": 15260, "tls": true },
///               "postgres":  { "port": 5432,  "scheme": "postgres" } } }
/// </code>
/// <para>
/// None of this is a translation, which is the thing <c>routes</c> deliberately
/// does not describe. It is what the server on the other end <em>is</em>: a
/// session has a certificate for its own name, so some of what it runs presents
/// that certificate and some does not, and some of what it runs is not HTTP at
/// all. A URL that guesses wrong is a protocol error rather than a page. envmux
/// has no way to find out other than being told — there is nothing in the
/// connection path to observe it with.
/// </para>
/// <para>
/// <c>tls</c> is the one-bit shorthand for the case that is nearly all of them.
/// <c>scheme</c> is the same field spelled out, for everything else. Saying both
/// is refused rather than resolved, because the two orders of precedence are
/// equally defensible and a route is not worth guessing about.
/// </para>
/// </remarks>
[JsonConverter(typeof(RouteConfigConverter))]
internal sealed record RouteConfig(int Port, string Scheme = RouteConfig.Http)
{
    public const string Http = "http";
    public const string Https = "https";

    /// <summary>Whether this route is reached over TLS, which is what a browser cares about.</summary>
    public bool Tls => Scheme.Equals(Https, StringComparison.Ordinal);

    /// <summary>A bare port means a plain HTTP route on it, which is the file's shorthand.</summary>
    /// <remarks>
    /// Here so that code reads the way the declaration does — <c>["vite"] = 5173</c>
    /// — rather than wrapping every port a caller already has.
    /// </remarks>
    public static implicit operator RouteConfig(int port) => new(port);

    public static RouteConfig FromInt32(int port) => new(port);
}

/// <summary>Reads <c>5173</c> and <c>{ "port": 5173, "tls": true }</c> as the same kind of thing.</summary>
internal sealed class RouteConfigConverter : JsonConverter<RouteConfig>
{
    public override RouteConfig Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Number)
        {
            return new RouteConfig(reader.GetInt32());
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                "a route is a port, or an object with a 'port' and a 'tls' or 'scheme' — like 5173, " +
                "{ \"port\": 5173, \"tls\": true }, or { \"port\": 5432, \"scheme\": \"postgres\" }");
        }

        int? port = null;
        bool? tls = null;
        string? scheme = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var property = reader.GetString();
            reader.Read();

            switch (property?.ToLowerInvariant())
            {
                case "port":
                    port = reader.GetInt32();
                    break;

                case "tls":
                    tls = reader.GetBoolean();
                    break;

                case "scheme":
                    scheme = reader.GetString();
                    break;

                default:
                    throw new JsonException(
                        $"'{property}' is not a field a route has — a route has 'port', 'tls' and 'scheme'");
            }
        }

        if (port is not { } declared)
        {
            throw new JsonException("a route written as an object still has to say which 'port'");
        }

        if (tls is not null && scheme is not null)
        {
            throw new JsonException(
                "a route says 'tls' or 'scheme', not both — 'tls': true is the shorthand for " +
                "'scheme': \"https\"");
        }

        if (scheme is null)
        {
            return new RouteConfig(declared, tls is true ? RouteConfig.Https : RouteConfig.Http);
        }

        scheme = scheme.Trim().TrimEnd(':', '/').ToLowerInvariant();

        // A scheme goes into a URL that a person clicks and a tool parses, and
        // the RFC 3986 shape is what both of them expect. Anything else lands as
        // a broken link much later, in a list where every other line works.
        return scheme.Length > 0 && char.IsAsciiLetter(scheme[0]) &&
               scheme.All(c => char.IsAsciiLetterOrDigit(c) || c is '+' or '-' or '.')
            ? new RouteConfig(declared, scheme)
            : throw new JsonException(
                $"'{scheme}' is not a URL scheme — a scheme starts with a letter and holds letters, " +
                "digits, '+', '-' and '.', like \"https\", \"postgres\" or \"redis\"");
    }

    public override void Write(Utf8JsonWriter writer, RouteConfig value, JsonSerializerOptions options)
    {
        if (value.Scheme.Equals(RouteConfig.Http, StringComparison.Ordinal))
        {
            writer.WriteNumberValue(value.Port);
            return;
        }

        writer.WriteStartObject();
        writer.WriteNumber("port", value.Port);

        if (value.Tls)
        {
            writer.WriteBoolean("tls", true);
        }
        else
        {
            writer.WriteString("scheme", value.Scheme);
        }

        writer.WriteEndObject();
    }
}
