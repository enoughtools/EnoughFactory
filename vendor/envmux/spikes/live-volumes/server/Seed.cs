using System.Text.Json;
using System.Text.Json.Nodes;

namespace Envmux.Live;

/// <summary>
/// A directory on this workstation and the directory it is inside the instance.
/// </summary>
/// <param name="From">The workstation path, any separator.</param>
/// <param name="To">The instance path, forward slashes.</param>
internal sealed record PathMapping(string From, string To)
{
    public string Root => Seed.Normalise(From);
}

/// <summary>
/// One Claude Code plugin the session is allowed to have.
/// </summary>
/// <param name="Name">The plugin, as <c>enabledPlugins</c> keys it: <c>prompt-context</c>.</param>
/// <param name="Marketplace">The marketplace it comes from: <c>prompt-skills</c>.</param>
/// <param name="Source">
/// Where that marketplace is, when this workstation does not already know —
/// <c>github:Owner/repo</c>. Null means take the workstation's record.
/// </param>
internal sealed record PluginSpec(string Name, string Marketplace, string? Source)
{
    public string Key => $"{Name}@{Marketplace}";

    /// <summary><c>name@marketplace</c> or <c>name@marketplace=github:Owner/repo</c>.</summary>
    public static PluginSpec Parse(string text)
    {
        var equals = text.IndexOf('=', StringComparison.Ordinal);
        var key = equals < 0 ? text : text[..equals];
        var source = equals < 0 ? null : text[(equals + 1)..];
        var at = key.IndexOf('@', StringComparison.Ordinal);

        return at < 0
            ? new PluginSpec(key, "claude-plugins-official", source)
            : new PluginSpec(key[..at], key[(at + 1)..], source);
    }
}

/// <summary>
/// The session's first copy of a shadowed file, made from the workstation's.
/// </summary>
/// <remarks>
/// <para>
/// A shadowed path is read from the workstation until the session writes its
/// own. For a credential that is exactly right — take what is there, diverge on
/// first write. For a file full of this workstation's absolute paths it is not:
/// <c>.claude.json</c> names seventy-four project directories by <c>Z:/</c> and
/// <c>C:/Users/Matt/</c>; <c>plugins/installed_plugins.json</c> says each
/// plugin is installed at <c>C:\Users\Matt\.claude\plugins\cache\…</c>. Read
/// inside a container those are at best noise. Measured, they are worse: the
/// tool found its plugin's recorded path unreachable, concluded the plugin was
/// not installed, and re-cloned two marketplaces — eight hundred writes on
/// startup, and the plugin the person had enabled still did not load.
/// </para>
/// <para>
/// So the session's copy of each is made once, at session start, with the paths
/// it can follow rewritten and the paths it cannot removed. Two roots are
/// mapped: the project directory to where the checkout lands inside the
/// instance, and the tool's own state directory to where this mount puts it.
/// Everything else that names a place on this machine is dropped, because there
/// is nothing on the other side to translate it to — and the list of directories
/// somebody works in is exactly the kind of thing that should not cross a
/// machine boundary because nobody thought to stop it.
/// </para>
/// <para>
/// Plugins are the same shape of decision. A workstation accumulates them; a
/// session is for one repository and gets the ones <c>.envmux.json</c> names,
/// which by default is none. The registries and <c>settings.json</c> are cut
/// down to that list on the way in, so the tool never sees a plugin it was not
/// given and has no reason to go and fetch one.
/// </para>
/// </remarks>
internal static class Seed
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// <summary>
    /// Rewrite <c>.claude.json</c> for one session.
    /// </summary>
    /// <param name="source">The workstation's file.</param>
    /// <param name="project">Where the repository is on this workstation and where it lands inside.</param>
    /// <param name="mappings">Every root that has an equivalent inside, the project included.</param>
    public static byte[] ClaudeJson(byte[] source, PathMapping project, IReadOnlyList<PathMapping> mappings)
    {
        if (JsonNode.Parse(source) is not JsonObject document)
        {
            return source;
        }

        var carried = document["projects"] is JsonObject projects
            ? Find(projects, project.Root)
            : null;

        // Re-keyed to the container's path, and trusted: the session is a
        // checkout of a repository the person already opened on this machine,
        // and stopping to ask again inside a container they asked envmux to make
        // is a dialog with no information in it.
        var entry = carried?.DeepClone().AsObject() ?? Fresh();

        entry["hasTrustDialogAccepted"] = true;
        entry["hasCompletedProjectOnboarding"] = true;

        // A worktree on the workstation, named by a path that is not in this
        // instance. Nothing here can resume it.
        entry.Remove("activeWorktreeSession");

        document["projects"] = new JsonObject { [project.To] = entry };

        Scrub(document, mappings, dropUnmapped: true);

        // githubRepoPaths maps a repository to the directories it is cloned in.
        // The scrub above emptied every list but this project's, and an entry
        // with an empty list still says the name of a repository the person
        // works on. Off it goes with its paths.
        if (document["githubRepoPaths"] is JsonObject repos)
        {
            foreach (var key in repos.Where(p => p.Value is not JsonArray { Count: > 0 }).Select(p => p.Key).ToList())
            {
                repos.Remove(key);
            }
        }

        return JsonSerializer.SerializeToUtf8Bytes(document, Indented);
    }

    /// <summary>
    /// <c>settings.json</c> with only the declared plugins enabled and only their
    /// marketplaces known.
    /// </summary>
    public static byte[] Settings(byte[] source, IReadOnlyList<PluginSpec> plugins)
    {
        if (JsonNode.Parse(source) is not JsonObject document)
        {
            return source;
        }

        var enabled = new JsonObject();

        foreach (var plugin in plugins)
        {
            enabled[plugin.Key] = true;
        }

        document["enabledPlugins"] = enabled;

        if (document["extraKnownMarketplaces"] is JsonObject extra)
        {
            var wanted = plugins.Select(p => p.Marketplace).ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var key in extra.Select(p => p.Key).Where(k => !wanted.Contains(k)).ToList())
            {
                extra.Remove(key);
            }

            // A marketplace the session declares with a source the workstation
            // has no record of is added here, which is where Claude Code looks
            // for marketplaces that are not the official one.
            foreach (var plugin in plugins.Where(p => p.Source is not null && !extra.ContainsKey(p.Marketplace)))
            {
                extra[plugin.Marketplace] = new JsonObject { ["source"] = SourceOf(plugin.Source!) };
            }
        }

        return JsonSerializer.SerializeToUtf8Bytes(document, Indented);
    }

    /// <summary><c>plugins/installed_plugins.json</c>, cut to the declared plugins, paths rewritten.</summary>
    public static byte[] InstalledPlugins(byte[] source, IReadOnlyList<PluginSpec> plugins, IReadOnlyList<PathMapping> mappings)
    {
        if (JsonNode.Parse(source) is not JsonObject document)
        {
            return source;
        }

        if (document["plugins"] is JsonObject installed)
        {
            var wanted = plugins.Select(p => p.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var key in installed.Select(p => p.Key).Where(k => !wanted.Contains(k)).ToList())
            {
                installed.Remove(key);
            }
        }

        Scrub(document, mappings, dropUnmapped: false);
        return JsonSerializer.SerializeToUtf8Bytes(document, Indented);
    }

    /// <summary><c>plugins/known_marketplaces.json</c>, cut to the marketplaces the declared plugins need.</summary>
    public static byte[] KnownMarketplaces(byte[] source, IReadOnlyList<PluginSpec> plugins, IReadOnlyList<PathMapping> mappings)
    {
        if (JsonNode.Parse(source) is not JsonObject document)
        {
            return source;
        }

        var wanted = plugins.Select(p => p.Marketplace).ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var key in document.Select(p => p.Key).Where(k => !wanted.Contains(k)).ToList())
        {
            document.Remove(key);
        }

        Scrub(document, mappings, dropUnmapped: false);
        return JsonSerializer.SerializeToUtf8Bytes(document, Indented);
    }

    /// <summary>The project's entry, however the tool spelled the path.</summary>
    /// <remarks>
    /// Claude Code writes these keys with forward slashes on Windows, so
    /// <c>Z:\envmux</c> is stored as <c>Z:/envmux</c>. Matching on the
    /// normalised form is what makes the settings carry over rather than the
    /// session starting from a blank entry that looks like it worked.
    /// </remarks>
    private static JsonObject? Find(JsonObject projects, string root)
    {
        foreach (var (key, value) in projects)
        {
            if (Normalise(key).Equals(root, StringComparison.OrdinalIgnoreCase) && value is JsonObject entry)
            {
                return entry;
            }
        }

        return null;
    }

    private static JsonObject Fresh() => new()
    {
        ["allowedTools"] = new JsonArray(),
        ["mcpContextUris"] = new JsonArray(),
        ["mcpServers"] = new JsonObject(),
        ["enabledMcpjsonServers"] = new JsonArray(),
        ["disabledMcpjsonServers"] = new JsonArray(),
        ["hasClaudeMdExternalIncludesApproved"] = false,
        ["hasClaudeMdExternalIncludesWarningShown"] = false,
    };

    /// <summary><c>github:Owner/repo</c> as Claude Code's marketplace source object.</summary>
    private static JsonObject SourceOf(string source)
    {
        var colon = source.IndexOf(':', StringComparison.Ordinal);
        var kind = colon < 0 ? "github" : source[..colon];
        var rest = colon < 0 ? source : source[(colon + 1)..];

        return kind switch
        {
            "github" => new JsonObject { ["source"] = "github", ["repo"] = rest },
            "git" => new JsonObject { ["source"] = "git", ["url"] = rest },
            _ => new JsonObject { ["source"] = kind, ["path"] = rest },
        };
    }

    /// <summary>
    /// Walk the document, rewriting this workstation's paths where a mapping
    /// covers them and — when asked — removing the ones nothing covers.
    /// </summary>
    private static void Scrub(JsonNode node, IReadOnlyList<PathMapping> mappings, bool dropUnmapped)
    {
        switch (node)
        {
            case JsonObject o:
            {
                foreach (var key in o.Select(p => p.Key).ToList())
                {
                    var value = o[key];

                    if (IsHostPath(key))
                    {
                        if (Map(key, mappings) is { } mapped)
                        {
                            o.Remove(key);
                            o[mapped] = value?.DeepClone();
                            value = o[mapped];
                        }
                        else if (dropUnmapped)
                        {
                            o.Remove(key);
                            continue;
                        }

                        if (value is not null)
                        {
                            Scrub(value, mappings, dropUnmapped);
                        }

                        continue;
                    }

                    if (IsString(value, out var text) && IsHostPath(text))
                    {
                        if (Map(text, mappings) is { } mapped)
                        {
                            o[key] = mapped;
                        }
                        else if (dropUnmapped)
                        {
                            o.Remove(key);
                        }

                        continue;
                    }

                    if (value is not null)
                    {
                        Scrub(value, mappings, dropUnmapped);
                    }
                }

                break;
            }

            case JsonArray a:
            {
                for (var i = a.Count - 1; i >= 0; i--)
                {
                    var value = a[i];

                    if (IsString(value, out var text) && IsHostPath(text))
                    {
                        if (Map(text, mappings) is { } mapped)
                        {
                            a[i] = mapped;
                        }
                        else if (dropUnmapped)
                        {
                            a.RemoveAt(i);
                        }

                        continue;
                    }

                    if (value is not null)
                    {
                        Scrub(value, mappings, dropUnmapped);
                    }
                }

                break;
            }

            default:
                break;
        }
    }

    private static bool IsString(JsonNode? value, out string text)
    {
        if (value is JsonValue v && v.GetValueKind() == JsonValueKind.String)
        {
            text = v.GetValue<string>();
            return true;
        }

        text = "";
        return false;
    }

    /// <summary>The instance path for a workstation path, or null if no root covers it.</summary>
    /// <remarks>Longest root first, so a project inside the home directory maps as the project.</remarks>
    private static string? Map(string path, IReadOnlyList<PathMapping> mappings)
    {
        var normalised = Normalise(path);

        foreach (var mapping in mappings.OrderByDescending(m => m.Root.Length))
        {
            var root = mapping.Root;

            if (normalised.Equals(root, StringComparison.OrdinalIgnoreCase))
            {
                return mapping.To;
            }

            if (normalised.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase))
            {
                return mapping.To + normalised[root.Length..];
            }
        }

        return null;
    }

    /// <summary>Whether a string names a place on this workstation.</summary>
    /// <remarks>
    /// A drive letter or a UNC prefix. Deliberately not "starts with a slash":
    /// this runs over a document that is about to be read on Linux, where a
    /// leading slash is the normal case and dropping every one of them would
    /// take the container's own paths with it.
    /// </remarks>
    private static bool IsHostPath(string text) =>
        (text.Length >= 3 && char.IsAsciiLetter(text[0]) && text[1] == ':' && (text[2] == '\\' || text[2] == '/')) ||
        text.StartsWith(@"\\", StringComparison.Ordinal);

    internal static string Normalise(string path) => path.Replace('\\', '/').TrimEnd('/');
}
