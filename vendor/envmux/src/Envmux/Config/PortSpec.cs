using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// A port to prefer, or a range to claim within.
/// </summary>
/// <remarks>
/// <para>
/// Written as either <c>8080</c> or <c>[2050, 2060]</c>. A range says "this
/// session belongs somewhere in here", which is what makes several concurrent
/// sessions predictable: a firewall rule, a bookmark, or a colleague's notes can
/// name the range rather than a port that moves.
/// </para>
/// <para>
/// The bare number keeps the old behaviour — try it, then walk upward — because
/// a single port with no room to move would fail the moment a second session
/// started.
/// </para>
/// </remarks>
[JsonConverter(typeof(PortSpecConverter))]
internal sealed record PortSpec(int First, int Last)
{
    /// <summary>How far a bare port is allowed to walk when it is taken.</summary>
    public const int DefaultWalk = 20;

    public static PortSpec Single(int port) => new(port, Math.Min(65535, port + DefaultWalk - 1));

    public static PortSpec Range(int first, int last) => new(first, last);

    public static readonly PortSpec Default = Single(SessionConfig.DefaultPort);

    /// <summary>Whether the config named a range rather than one port.</summary>
    public bool IsRange => Last - First != DefaultWalk - 1;

    /// <summary>How many ports this may occupy.</summary>
    public int Count => Last - First + 1;

    /// <summary>The ports to try, in order.</summary>
    public IEnumerable<int> Candidates()
    {
        for (var port = First; port <= Last && port <= 65535; port++)
        {
            yield return port;
        }
    }

    public override string ToString() =>
        IsRange
            ? $"{First}-{Last}"
            : First.ToString(CultureInfo.InvariantCulture);

    /// <summary>Reject anything that is not a usable range before a session starts.</summary>
    public void Validate()
    {
        if (First is < 1 or > 65535 || Last is < 1 or > 65535)
        {
            throw new ConfigException($"'port' {this} is outside 1-65535");
        }

        if (Last < First)
        {
            throw new ConfigException($"'port' range [{First}, {Last}] ends before it starts");
        }
    }
}

/// <summary>
/// Reads <c>"port": 8080</c> and <c>"port": [2050, 2060]</c> as the same thing.
/// </summary>
internal sealed class PortSpecConverter : JsonConverter<PortSpec>
{
    public override PortSpec? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Number)
        {
            return PortSpec.Single(reader.GetInt32());
        }

        if (reader.TokenType != JsonTokenType.StartArray)
        {
            throw new JsonException("'port' must be a number, or a two-element range like [2050, 2060]");
        }

        var bounds = new List<int>(2);
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.Number)
            {
                throw new JsonException("a 'port' range holds numbers, like [2050, 2060]");
            }

            bounds.Add(reader.GetInt32());
        }

        return bounds.Count switch
        {
            // A one-element range is a port somebody meant to widen later.
            1 => PortSpec.Single(bounds[0]),
            2 => PortSpec.Range(bounds[0], bounds[1]),
            _ => throw new JsonException(
                $"a 'port' range has two elements, not {bounds.Count} — like [2050, 2060]"),
        };
    }

    public override void Write(Utf8JsonWriter writer, PortSpec value, JsonSerializerOptions options)
    {
        if (value.IsRange)
        {
            writer.WriteStartArray();
            writer.WriteNumberValue(value.First);
            writer.WriteNumberValue(value.Last);
            writer.WriteEndArray();
        }
        else
        {
            writer.WriteNumberValue(value.First);
        }
    }
}
