using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// One dev container feature, and whatever it was configured with.
/// </summary>
/// <remarks>
/// <para>
/// The options are strings because that is how a feature receives them. The
/// specification passes each option to <c>install.sh</c> as an environment
/// variable named after it, and an environment variable is a string — so
/// <c>{"version": 10}</c> and <c>{"version": "10"}</c> reach the script
/// identically, and keeping them apart in the model would be keeping a
/// distinction that stops existing one line later.
/// </para>
/// <para>
/// That is also why this has a converter rather than being a plain dictionary:
/// a <c>.envmux.json</c> copied out of a <c>devcontainer.json</c> has booleans
/// and numbers in it, and rejecting those would be rejecting the file people
/// actually have.
/// </para>
/// </remarks>
[JsonConverter(typeof(FeatureOptionsConverter))]
internal sealed record FeatureConfig
{
    /// <summary>Option name to value, as the feature's own schema names them.</summary>
    public Dictionary<string, string> Options { get; init; } = [];
}

/// <summary>Reads a feature's options, whatever JSON scalar each one is written as.</summary>
internal sealed class FeatureOptionsConverter : JsonConverter<FeatureConfig>
{
    public override FeatureConfig Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // `"ghcr.io/…/node:1": {}` is the common case and the one people write
        // when they want the defaults.
        if (reader.TokenType == JsonTokenType.Null)
        {
            return new FeatureConfig();
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                "a feature's options must be an object, as in " +
                "\"ghcr.io/devcontainers/features/node:1\": { \"version\": \"lts\" }");
        }

        var values = new Dictionary<string, string>(StringComparer.Ordinal);

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var name = reader.GetString() ?? "";
            reader.Read();

            values[name] = reader.TokenType switch
            {
                JsonTokenType.String => reader.GetString() ?? "",

                // Lowercase, because that is what a feature's install.sh
                // compares against — `if [ "$INSTALLZSH" = "true" ]`.
                JsonTokenType.True => "true",
                JsonTokenType.False => "false",

                // As it was written, so `"version": 22` reaches install.sh as
                // "22" rather than "22.0" and matches a version string.
                JsonTokenType.Number => Trimmed(reader.GetDouble()),

                JsonTokenType.Null => "",

                _ => throw new JsonException(
                    $"the option '{name}' is a {reader.TokenType}, and a feature can only be given " +
                    "a string, a number or a boolean"),
            };
        }

        return new FeatureConfig { Options = values };
    }

    /// <summary>A number as a person wrote it: <c>10</c>, not <c>10.0</c>.</summary>
    private static string Trimmed(double value) =>
        value == Math.Floor(value) && Math.Abs(value) < 1e15
            ? ((long)value).ToString(CultureInfo.InvariantCulture)
            : value.ToString(CultureInfo.InvariantCulture);

    public override void Write(Utf8JsonWriter writer, FeatureConfig value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();

        foreach (var (name, option) in value.Options)
        {
            writer.WriteString(name, option);
        }

        writer.WriteEndObject();
    }
}
