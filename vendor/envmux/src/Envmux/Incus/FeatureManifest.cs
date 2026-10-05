using System.Net.Http.Headers;
using System.Text.Json;

namespace Envmux.Incus;

/// <summary>What a feature says about itself.</summary>
/// <param name="Id">Its short name, e.g. <c>dotnet</c>.</param>
/// <param name="Version">The version of the feature, not of what it installs.</param>
/// <param name="Defaults">Every option it declares, and what it defaults to.</param>
/// <param name="ContainerEnv">
/// Environment the feature expects to exist, <b>in declaration order</b>. The
/// order is load-bearing: dotnet declares <c>DOTNET_ROOT</c> and then
/// <c>PATH</c> as <c>$PATH:$DOTNET_ROOT</c>, so sorting these by name sets PATH
/// against a variable that does not exist yet.
/// </param>
internal sealed record FeatureMetadata(
    string Id,
    string Version,
    IReadOnlyDictionary<string, string> Defaults,
    IReadOnlyList<KeyValuePair<string, string>> ContainerEnv);

/// <summary>
/// Reading a feature's own description of itself, before installing it.
/// </summary>
/// <remarks>
/// <para>
/// This exists because of one measured failure. A feature's <c>install.sh</c>
/// does <em>not</em> supply its own defaults — the specification says the tool
/// applies them from <c>devcontainer-feature.json</c> and passes every option as
/// an environment variable. Installing <c>dotnet:2</c> with only
/// <c>VERSION=10.0</c> set therefore ran
/// <c>dotnet-install.sh --install-dir</c> with nothing after it, and failed on
/// <c>mkdir: cannot create directory ''</c>: a message about an empty
/// string, from a script nobody wrote, several layers below the option that was
/// never set.
/// </para>
/// <para>
/// It is read here rather than in the instance because this is JSON, and parsing
/// JSON with <c>sed</c> is the kind of thing that works until a feature adds a
/// nested object to its schema. envmux already talks to a registry over HTTPS;
/// one more manifest is not a new capability.
/// </para>
/// <para>
/// <c>containerEnv</c> comes back for the same reason. A feature that installs
/// nvm expects <c>NVM_DIR</c> and a <c>PATH</c> entry to exist for every shell
/// afterwards, and without them the thing it installed is present and not
/// findable.
/// </para>
/// </remarks>
internal static class FeatureManifest
{
    /// <summary>The annotation a feature's metadata is carried in.</summary>
    private const string Annotation = "dev.containers.metadata";

    /// <summary>
    /// Fetch what a feature declares, or null if it cannot be read.
    /// </summary>
    /// <remarks>
    /// Null rather than throwing, because a feature whose metadata cannot be
    /// read can still be installed — with whatever options were given
    /// explicitly, which is what happened before this existed. Refusing to
    /// install because a description could not be fetched would be worse than
    /// the problem.
    /// </remarks>
    /// <param name="feature">The feature to ask about.</param>
    /// <param name="http">The client to ask with.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task<FeatureMetadata?> ReadAsync(
        Feature feature,
        HttpClient http,
        CancellationToken ct = default)
    {
        try
        {
            var token = await TokenAsync(feature, http, ct).ConfigureAwait(false);

            if (token is null)
            {
                return null;
            }

            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://{feature.Registry}/v2/{feature.Repository}/manifests/{feature.Tag}");

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/vnd.oci.image.manifest.v1+json"));

            using var response = await http.SendAsync(request, ct).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            return Parse(body);
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or TaskCanceledException)
        {
            return null;
        }
    }

    /// <summary>An anonymous pull token, which is all a public feature needs.</summary>
    private static async Task<string?> TokenAsync(Feature feature, HttpClient http, CancellationToken ct)
    {
        var url =
            $"https://{feature.Registry}/token" +
            $"?scope=repository:{feature.Repository}:pull&service={feature.Registry}";

        using var response = await http.GetAsync(url, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        using var document = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));

        return document.RootElement.TryGetProperty("token", out var token)
            ? token.GetString()
            : null;
    }

    /// <summary>
    /// Pull the metadata out of a manifest.
    /// </summary>
    /// <remarks>
    /// It is a JSON document inside a string inside a JSON document, which is
    /// how OCI annotations carry anything structured.
    /// </remarks>
    internal static FeatureMetadata? Parse(string manifest)
    {
        using var document = JsonDocument.Parse(manifest);

        if (!document.RootElement.TryGetProperty("annotations", out var annotations) ||
            !annotations.TryGetProperty(Annotation, out var carried) ||
            carried.GetString() is not { } text)
        {
            return null;
        }

        using var metadata = JsonDocument.Parse(text);
        var root = metadata.RootElement;

        var defaults = new Dictionary<string, string>(StringComparer.Ordinal);

        if (root.TryGetProperty("options", out var options) &&
            options.ValueKind == JsonValueKind.Object)
        {
            foreach (var option in options.EnumerateObject())
            {
                if (option.Value.ValueKind == JsonValueKind.Object &&
                    option.Value.TryGetProperty("default", out var value) &&
                    Scalar(value) is { } scalar)
                {
                    defaults[option.Name] = scalar;
                }
            }
        }

        // A list, in the order the feature wrote them, because they reference
        // each other.
        var environment = new List<KeyValuePair<string, string>>();

        if (root.TryGetProperty("containerEnv", out var containerEnv) &&
            containerEnv.ValueKind == JsonValueKind.Object)
        {
            foreach (var variable in containerEnv.EnumerateObject())
            {
                if (Scalar(variable.Value) is { } scalar)
                {
                    environment.Add(new KeyValuePair<string, string>(variable.Name, scalar));
                }
            }
        }

        return new FeatureMetadata(
            Text(root, "id"),
            Text(root, "version"),
            defaults,
            environment);
    }

    /// <summary>A JSON scalar as the string an environment variable would hold.</summary>
    private static string? Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Number => value.ToString(),
        _ => null,
    };

    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
}
