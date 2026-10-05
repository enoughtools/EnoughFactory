using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Host;

namespace Envmux.Docker;

/// <summary>A mount the client asked for, kept so inspect can hand it back.</summary>
/// <remarks>
/// Nothing is ever mounted across this boundary — the client's filesystem is
/// on another machine. What is kept is the request, because the extension
/// reads its own mounts back off inspect, and because a target under
/// <c>/workspaces</c> is provisioned on the instance in place of the bind.
/// </remarks>
internal sealed record ShimMount(string Type, string Source, string Destination, bool ReadWrite);

/// <summary>
/// One container the shim has handed out: the instance behind it, and what
/// the client said when it made it.
/// </summary>
/// <remarks>
/// The labels are the whole reason this is persisted. The extension finds an
/// existing container for a workspace by filtering on
/// <c>devcontainer.local_folder</c> and <c>devcontainer.config_file</c>, and
/// the values have to come back byte-identical — Windows paths, backslashes,
/// the lowercased drive letter the extension puts on one and not the other.
/// Kept verbatim here rather than squeezed through instance config keys.
/// docs/vscode-remote.md §5.
/// </remarks>
internal sealed record ShimContainer
{
    /// <summary>64 hex characters, as Docker's are — the SHA-256 of the instance name, so it is stable across restarts.</summary>
    public required string Id { get; set; }

    /// <summary>The <c>--name</c> the client gave, or the instance name.</summary>
    public required string Name { get; set; }

    /// <summary>The Incus instance this is.</summary>
    public required string Instance { get; set; }

    public DateTimeOffset Created { get; set; }

    public Dictionary<string, string> Labels { get; set; } = new(StringComparer.Ordinal);

    public string Image { get; set; } = "";

    public IReadOnlyList<string>? Cmd { get; set; }

    public IReadOnlyList<string>? Entrypoint { get; set; }

    public IReadOnlyList<string> Env { get; set; } = [];

    public string User { get; set; } = "";

    public string WorkingDir { get; set; } = "";

    public IReadOnlyList<ShimMount> Mounts { get; set; } = [];
}

/// <summary>
/// What the shim remembers between runs: its containers, and its volumes.
/// </summary>
/// <remarks>
/// One JSON file beside <c>host.json</c>. Container ids are derived from
/// instance names, so a lost file loses labels rather than identity — the
/// instances are still there, still listed, and the next connect makes a new
/// container rather than reattaching. Which is the failure mode the spec
/// warns about, and why this is written on every change.
/// </remarks>
internal sealed class ShimState
{
    public const string FileName = "docker.json";

    private static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Lock _gate = new();

    public Dictionary<string, ShimContainer> Containers { get; set; } = new(StringComparer.Ordinal);

    /// <summary>Volumes by name, each carrying the labels it was created with. Nothing is stored behind one.</summary>
    public Dictionary<string, Dictionary<string, string>> Volumes { get; set; } = new(StringComparer.Ordinal);

    public static string Location => Path.Combine(HostConfig.Directory, FileName);

    public static ShimState Load()
    {
        try
        {
            return File.Exists(Location)
                ? WireJson.Deserialize<ShimState>(File.ReadAllText(Location), Options) ?? new ShimState()
                : new ShimState();
        }
        catch (JsonException)
        {
            // A file that does not parse is a file that is about to be
            // replaced. Losing labels is recoverable; refusing to start is not.
            return new ShimState();
        }
    }

    public void Save()
    {
        lock (_gate)
        {
            Directory.CreateDirectory(HostConfig.Directory);
            File.WriteAllText(Location, WireJson.Serialize(this, Options));
        }
    }

    public ShimContainer? ByInstance(string instance)
    {
        lock (_gate)
        {
            return Containers.Values.FirstOrDefault(c => c.Instance.Equals(instance, StringComparison.Ordinal));
        }
    }

    public void Put(ShimContainer container)
    {
        lock (_gate)
        {
            Containers[container.Id] = container;
        }

        Save();
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            Containers.Remove(id);
        }

        Save();
    }
}
