using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Docker;

/// <summary>How the Docker side of the wire is shaped: PascalCase, and generous on the way in.</summary>
internal static class DockerJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}

/// <summary>The body of <c>POST /containers/create</c>, the parts that matter.</summary>
internal sealed record ContainerCreateRequest
{
    public string Image { get; set; } = "";

    public Dictionary<string, string>? Labels { get; set; }

    public IReadOnlyList<string>? Cmd { get; set; }

    public IReadOnlyList<string>? Entrypoint { get; set; }

    public IReadOnlyList<string>? Env { get; set; }

    public string? User { get; set; }

    public string? WorkingDir { get; set; }

    public HostConfigRequest? HostConfig { get; set; }
}

internal sealed record HostConfigRequest
{
    public IReadOnlyList<MountRequest>? Mounts { get; set; }

    /// <summary><c>host:container[:options]</c>, the older spelling of a bind.</summary>
    public IReadOnlyList<string>? Binds { get; set; }
}

internal sealed record MountRequest
{
    public string Type { get; set; } = "bind";

    public string Source { get; set; } = "";

    public string Target { get; set; } = "";

    public bool ReadOnly { get; set; }
}

/// <summary>The body of <c>POST /containers/{id}/exec</c>.</summary>
internal sealed record ExecCreateRequest
{
    public bool AttachStdin { get; set; }

    public bool AttachStdout { get; set; }

    public bool AttachStderr { get; set; }

    public bool Tty { get; set; }

    public IReadOnlyList<string> Cmd { get; set; } = [];

    /// <summary><c>KEY=value</c> pairs, Docker's spelling.</summary>
    public IReadOnlyList<string>? Env { get; set; }

    public string? User { get; set; }

    public string? WorkingDir { get; set; }

    /// <summary>The environment as a map, which is what Incus takes.</summary>
    public IReadOnlyDictionary<string, string> Environment()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var pair in Env ?? [])
        {
            var eq = pair.IndexOf('=', StringComparison.Ordinal);
            map[eq < 0 ? pair : pair[..eq]] = eq < 0 ? "" : pair[(eq + 1)..];
        }

        return map;
    }
}

/// <summary>The body of <c>POST /exec/{id}/start</c>.</summary>
internal sealed record ExecStartRequest
{
    public bool Detach { get; set; }

    public bool Tty { get; set; }
}

/// <summary>The body of <c>POST /volumes/create</c>.</summary>
internal sealed record VolumeCreateRequest
{
    public string? Name { get; set; }

    public Dictionary<string, string>? Labels { get; set; }
}

/// <summary>
/// The <c>filters</c> query parameter, in either of the shapes the CLI sends.
/// </summary>
/// <remarks>
/// <c>{"label":{"a=b":true}}</c> from a current CLI, <c>{"label":["a=b"]}</c>
/// from an older one. Both mean the same list.
/// </remarks>
internal static class DockerFilters
{
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Parse(string? filters)
    {
        var map = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

        if (string.IsNullOrWhiteSpace(filters))
        {
            return map;
        }

        using var document = JsonDocument.Parse(filters);

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            return map;
        }

        foreach (var property in document.RootElement.EnumerateObject())
        {
            map[property.Name] = property.Value.ValueKind switch
            {
                JsonValueKind.Array => [.. property.Value.EnumerateArray().Select(v => v.GetString() ?? "")],
                JsonValueKind.Object => [.. property.Value.EnumerateObject().Select(p => p.Name)],
                _ => [],
            };
        }

        return map;
    }

    /// <summary>Whether a container passes every filter: label, name, id and status.</summary>
    public static bool Matches(
        IReadOnlyDictionary<string, IReadOnlyList<string>> filters,
        ShimContainer container,
        bool running)
    {
        if (filters.TryGetValue("label", out var labels))
        {
            foreach (var wanted in labels)
            {
                var eq = wanted.IndexOf('=', StringComparison.Ordinal);

                var ok = eq < 0
                    ? container.Labels.ContainsKey(wanted)
                    : container.Labels.TryGetValue(wanted[..eq], out var value) &&
                      value.Equals(wanted[(eq + 1)..], StringComparison.Ordinal);

                if (!ok)
                {
                    return false;
                }
            }
        }

        if (filters.TryGetValue("name", out var names) &&
            names.Any(n => !container.Name.Contains(n, StringComparison.Ordinal)))
        {
            return false;
        }

        if (filters.TryGetValue("id", out var ids) &&
            ids.Any(i => !container.Id.StartsWith(i, StringComparison.Ordinal)))
        {
            return false;
        }

        if (filters.TryGetValue("status", out var statuses) && statuses.Count > 0)
        {
            var status = running ? "running" : "exited";

            if (!statuses.Contains(status, StringComparer.Ordinal))
            {
                return false;
            }
        }

        return true;
    }
}
