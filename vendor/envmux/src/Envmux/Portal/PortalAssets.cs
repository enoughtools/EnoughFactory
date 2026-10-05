using System.IO.Compression;

namespace Envmux.Portal;

/// <summary>One file of the built page.</summary>
/// <param name="Bytes">Its contents.</param>
/// <param name="ContentType">What to say it is.</param>
/// <param name="Immutable">
/// Whether its name contains its own hash, and so may be cached forever.
/// </param>
internal sealed record PortalAsset(byte[] Bytes, string ContentType, bool Immutable);

/// <summary>
/// The built page, carried inside the executable.
/// </summary>
/// <remarks>
/// <para>
/// One zip, embedded as a resource at build time and unpacked into memory the
/// first time somebody asks for a file. A few hundred kilobytes: smaller than
/// the alternatives — a directory beside the binary that a single-file tool on
/// a PATH cannot assume exists, or a hundred separate embedded resources whose
/// names have to be mangled to survive being resource names.
/// </para>
/// <para>
/// It is allowed to be missing. A working tree with no Node installed still
/// builds, still runs, and still routes; what it does not do is serve a page,
/// and <see cref="Built"/> is how everything above here finds that out and says
/// so instead of serving an empty tab.
/// </para>
/// </remarks>
internal static class PortalAssets
{
    /// <summary>
    /// The resource the build puts the zip in.
    /// </summary>
    /// <remarks>
    /// Named explicitly by the csproj rather than derived from a path, because a
    /// resource name derived from a path is one that changes when the folder is
    /// renamed and fails at runtime rather than at build.
    /// </remarks>
    public const string ResourceName = "Envmux.Portal.zip";

    private static readonly Lazy<IReadOnlyDictionary<string, PortalAsset>> Contents = new(Load);

    /// <summary>Whether there is a page to serve at all.</summary>
    public static bool Built => Contents.Value.Count > 0;

    /// <summary>Every path in the bundle, for the diagnostics that ask.</summary>
    public static IEnumerable<string> Paths => Contents.Value.Keys;

    /// <summary>
    /// The file at this request path, or null.
    /// </summary>
    /// <remarks>
    /// <c>/</c> is the page itself. Anything else is looked up literally, so a
    /// request for a name that is not in the bundle is a miss rather than a
    /// silently-served index — the caller decides which of those deserves the
    /// page and which deserves a 404, and for a single-page app the answer
    /// differs between <c>/assets/…</c> and everything else.
    /// </remarks>
    public static PortalAsset? Find(string path)
    {
        var name = path.TrimStart('/');

        if (name.Length == 0)
        {
            name = "index.html";
        }

        return Contents.Value.TryGetValue(name, out var asset) ? asset : null;
    }

    /// <summary>The page itself, for the paths a single-page app answers with it.</summary>
    public static PortalAsset? Index => Find("/");

    private static Dictionary<string, PortalAsset> Load()
    {
        var files = new Dictionary<string, PortalAsset>(StringComparer.Ordinal);

        using var stream = typeof(PortalAssets).Assembly.GetManifestResourceStream(ResourceName);
        if (stream is null)
        {
            return files;
        }

        using var zip = new ZipArchive(stream, ZipArchiveMode.Read);

        foreach (var entry in zip.Entries)
        {
            // Directory entries have no name; everything else is read whole,
            // because the whole bundle is smaller than the bookkeeping needed
            // to stream one file out of a zip on every request.
            if (entry.Name.Length == 0)
            {
                continue;
            }

            using var contents = entry.Open();
            using var buffer = new MemoryStream();
            contents.CopyTo(buffer);

            var path = entry.FullName.Replace('\\', '/').TrimStart('/');

            // Vite writes the content hash into the name of everything it emits
            // under assets/. Those may be cached until the heat death of the
            // tab; index.html names them and must not be.
            var hashed = path.StartsWith("assets/", StringComparison.Ordinal);

            files[path] = new PortalAsset(buffer.ToArray(), ContentType(path), hashed);
        }

        return files;
    }

    private static string ContentType(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" or ".mjs" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" or ".map" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".ico" => "image/x-icon",
            ".woff2" => "font/woff2",
            ".woff" => "font/woff",
            ".txt" => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        };
}
