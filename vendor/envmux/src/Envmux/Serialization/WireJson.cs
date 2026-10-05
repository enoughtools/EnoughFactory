global using Envmux.Serialization;

using System.Collections;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Envmux.Serialization;

/// <summary>Generated JSON metadata, with explicit objects for ad hoc wire responses.</summary>
/// <remarks>
/// Anonymous CLR types cannot be listed in a source-generation context. Wire
/// objects therefore name their fields explicitly. Dictionaries and sequences
/// are walked without reflecting over their implementation types; domain models
/// still use the generated contracts and the caller's original serializer policy.
/// </remarks>
internal static class WireJson
{
    private static readonly JsonSerializerOptions Default = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
    };

    public static JsonTypeInfo<T> Info<T>(JsonSerializerOptions options) =>
        (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T));

    public static T? Deserialize<T>(string json, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize(json, Info<T>(options));

    public static T? Deserialize<T>(ReadOnlySpan<byte> json, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize(json, Info<T>(options));

    public static T? Deserialize<T>(JsonElement json, JsonSerializerOptions options) =>
        json.Deserialize(Info<T>(options));

    public static string Serialize<T>(T value, JsonSerializerOptions? options = null)
    {
        options ??= Default;
        return JsonSerializer.Serialize(Node(value, options), Info<JsonNode?>(options));
    }

    public static byte[] SerializeToUtf8Bytes<T>(T value, JsonSerializerOptions options) =>
        Encoding.UTF8.GetBytes(Serialize(value, options));

    public static HttpContent Content(object value, JsonSerializerOptions options) =>
        JsonContent.Create(Node(value, options), Info<JsonNode?>(options));

    public static JsonObject Object(JsonSerializerOptions options, params (string Name, object? Value)[] fields)
    {
        var result = new JsonObject();
        foreach (var (name, value) in fields)
        {
            if (value is null && options.DefaultIgnoreCondition == JsonIgnoreCondition.WhenWritingNull)
            {
                continue;
            }

            result[options.PropertyNamingPolicy?.ConvertName(name) ?? name] = Node(value, options);
        }

        return result;
    }

    private static JsonNode? Node(object? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            return null;
        }

        if (value is JsonNode node)
        {
            return node.DeepClone();
        }

        if (value is IDictionary dictionary)
        {
            var result = new JsonObject();
            foreach (DictionaryEntry entry in dictionary)
            {
                result[(string)entry.Key] = Node(entry.Value, options);
            }

            return result;
        }

        if (value is IEnumerable sequence && value is not string)
        {
            var result = new JsonArray();
            foreach (var item in sequence)
            {
                result.Add(Node(item, options));
            }

            return result;
        }

        return JsonSerializer.SerializeToNode(value, options.GetTypeInfo(value.GetType()));
    }
}
