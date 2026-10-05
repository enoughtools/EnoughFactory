using System.Globalization;

namespace Envmux.Live;

/// <summary>One thing in the tree, as WebDAV needs to describe it.</summary>
/// <param name="Name">Its last path segment.</param>
/// <param name="IsDirectory">Whether a client should walk into it.</param>
/// <param name="Length">Bytes, zero for a directory.</param>
/// <param name="Modified">Last write, UTC.</param>
/// <param name="HostPath">Where it is on this workstation, or null for a placeholder.</param>
internal sealed record Entry(
    string Name,
    bool IsDirectory,
    long Length,
    DateTimeOffset Modified,
    string? HostPath)
{
    /// <summary>
    /// An identity for the bytes, so a client can tell a change from a re-read.
    /// </summary>
    /// <remarks>
    /// Size and mtime rather than a hash: this is asked for on every stat of
    /// every file in the tree, and hashing a 150 KB <c>.claude.json</c> on each
    /// one would be the whole cost of the mount. The pair moves whenever a
    /// writer that is not lying moves it.
    /// </remarks>
    public string ETag =>
        $"\"{Length.ToString("x", CultureInfo.InvariantCulture)}-" +
        $"{Modified.ToUnixTimeMilliseconds().ToString("x", CultureInfo.InvariantCulture)}\"";
}

/// <summary>What a request resolved to, and how it should be answered.</summary>
/// <param name="Route">Where it is read and written.</param>
/// <param name="Namespace">The tool it belongs to, or null at the root.</param>
/// <param name="Relative">The path within that namespace, forward slashes, no leading one.</param>
/// <param name="HostPath">
/// The file or directory backing it, or null for a virtual one. For
/// <see cref="Route.Shadow"/> this is the session's copy — where a write goes,
/// and where a read looks first.
/// </param>
/// <param name="FallbackPath">
/// Where a <see cref="Route.Shadow"/> read falls back to when the session has
/// not written its own copy yet: the workstation's file. Null for every other
/// route.
/// </param>
internal sealed record Resolution(
    Route Route,
    Namespace? Namespace,
    string Relative,
    string? HostPath,
    string? FallbackPath = null)
{
    /// <summary>Where a read of this path should actually look.</summary>
    /// <remarks>
    /// One line, in one place, because getting it wrong in one verb and right in
    /// the others is how a shadowed file ends up served from the workstation
    /// after the session has already replaced it.
    /// </remarks>
    public string? ReadPath =>
        Route == Route.Shadow && HostPath is not null && !File.Exists(HostPath)
            ? FallbackPath
            : HostPath;
}

/// <summary>
/// The namespace the guest mounts: tool names at the root, and under each one a
/// view assembled from the workstation's own state, this session's overlay, and
/// empty directories for what the guest keeps itself.
/// </summary>
internal sealed class Tree(IReadOnlyList<Namespace> namespaces, string overlayRoot)
{
    public IReadOnlyList<Namespace> Namespaces => namespaces;

    /// <summary>Where this session's unclassified files are kept, on the workstation.</summary>
    public string OverlayRoot => overlayRoot;

    /// <summary>
    /// Resolve a request path.
    /// </summary>
    /// <param name="path">The URL path, decoded, with or without a leading slash.</param>
    public Resolution Resolve(string path)
    {
        var trimmed = path.Trim('/');

        if (trimmed.Length == 0)
        {
            return new Resolution(Route.Live, null, "", null);
        }

        var slash = trimmed.IndexOf('/', StringComparison.Ordinal);
        var head = slash < 0 ? trimmed : trimmed[..slash];
        var rest = slash < 0 ? "" : trimmed[(slash + 1)..];

        var ns = namespaces.FirstOrDefault(n => n.Name.Equals(head, StringComparison.OrdinalIgnoreCase));

        if (ns is null)
        {
            return new Resolution(Route.Denied, null, trimmed, null);
        }

        if (ns.Name == Policy.Git)
        {
            // git/<host>, and nothing deeper. A host with a slash in it is not a
            // host.
            return rest.Length == 0 || !rest.Contains('/')
                ? new Resolution(Route.Virtual, ns, rest, null)
                : new Resolution(Route.Denied, ns, rest, null);
        }

        var route = ns.RouteFor(rest);

        var hostPath = route switch
        {
            Route.Live => ns.HostPathFor(rest),
            Route.Shadow or Route.Overlay => Overlay(ns, rest),
            _ => null,
        };

        var fallback = route == Route.Shadow ? ns.HostPathFor(rest) : null;

        // HostPathFor returns null for a path that climbed out of the root.
        return hostPath is null && route is Route.Live or Route.Shadow or Route.Overlay
            ? new Resolution(Route.Denied, ns, rest, null)
            : new Resolution(route, ns, rest, hostPath, fallback);
    }

    private string? Overlay(Namespace ns, string relative)
    {
        var root = Path.Combine(overlayRoot, ns.Name);
        var full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));

        return full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            ? full
            : null;
    }

    /// <summary>
    /// Describe one resolved path, or null if there is nothing there.
    /// </summary>
    public static Entry? Stat(Resolution at, string name)
    {
        switch (at.Route)
        {
            case Route.Denied:
                return null;

            case Route.Placeholder:
                // Always there, always empty. The guest mounts over it, and a
                // directory that appears only once something is in it is a
                // directory the guest cannot mount over.
                return new Entry(name, IsDirectory: true, 0, DateTimeOffset.UnixEpoch, null);

            case Route.Virtual:
                // Only the directory. Its entries are described by the server
                // that answers them, because their size is not known until then.
                return at.Relative.Length == 0
                    ? new Entry(name, IsDirectory: true, 0, DateTimeOffset.UnixEpoch, null)
                    : null;

            default:
                break;
        }

        // The root, and each namespace's root, exist whether or not the
        // workstation has the directory: a tool that is not installed here is an
        // empty mount rather than a mount that fails.
        if (at.Namespace is null || at.Relative.Length == 0)
        {
            return new Entry(name, IsDirectory: true, 0, DateTimeOffset.UnixEpoch, at.HostPath);
        }

        var path = at.ReadPath!;

        if (Directory.Exists(path))
        {
            return new Entry(name, true, 0, Directory.GetLastWriteTimeUtc(path), path);
        }

        if (File.Exists(path))
        {
            var info = new FileInfo(path);
            return new Entry(name, false, info.Length, info.LastWriteTimeUtc, path);
        }

        return null;
    }

    /// <summary>
    /// What is directly inside a resolved directory.
    /// </summary>
    /// <remarks>
    /// The one place the three sources are put together. At a namespace's root
    /// that is: the classified live entries the workstation actually has, an
    /// empty directory for each local one, and whatever this session has written
    /// into its overlay. Deeper down a path belongs to exactly one of them, so
    /// the listing is just that one directory.
    /// </remarks>
    public IReadOnlyList<(string Name, Resolution At)> Children(Resolution at)
    {
        if (at.Namespace is null)
        {
            return [.. namespaces.Select(n => (n.Name, Resolve(n.Name)))];
        }

        // Virtual directories are listed by whoever serves them; Denied and
        // Placeholder have nothing in them by definition.
        if (at.Route is Route.Placeholder or Route.Denied or Route.Virtual)
        {
            return [];
        }

        var ns = at.Namespace;
        var prefix = at.Relative.Length == 0 ? "" : at.Relative + "/";
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

        if (at.Relative.Length == 0)
        {
            foreach (var name in ns.Live.Concat(ns.Shadow))
            {
                if (ns.HostPathFor(name) is { } p && (File.Exists(p) || Directory.Exists(p)))
                {
                    names.Add(name);
                }
            }

            foreach (var name in ns.Local)
            {
                names.Add(name);
            }

            Collect(Path.Combine(overlayRoot, ns.Name), names);
        }
        else if (at.Route == Route.Shadow)
        {
            // A shadowed directory is the union of both sides: what the
            // workstation has, and what the session has written since. Per
            // file the session's copy wins, which Stat already arranges through
            // ReadPath; this is only about which names appear at all. Without
            // it, the first file a tool wrote into plugins/ would make the
            // session's copy of the directory exist, and the listing would
            // switch to it and lose every plugin the workstation has.
            Collect(at.HostPath!, names);
            Collect(at.FallbackPath!, names);
        }
        else if (at.ReadPath is { } dir)
        {
            Collect(dir, names);
        }

        return [.. names.Select(n => (n, Resolve($"{ns.Name}/{prefix}{n}")))];
    }

    private static void Collect(string directory, SortedSet<string> into)
    {
        if (!Directory.Exists(directory))
        {
            return;
        }

        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            into.Add(Path.GetFileName(path));
        }
    }
}
