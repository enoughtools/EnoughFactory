namespace Envmux.Config;

/// <summary>
/// A path with every symlinked component resolved, which is the spelling git
/// reports back.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Path.GetFullPath(string)"/> normalises separators and <c>..</c>
/// but never follows a link, so one directory can have two absolute spellings
/// that compare unequal. macOS is where this bites: <c>/tmp</c> and every
/// temporary directory live under <c>/var</c>, which is a symlink to
/// <c>/private/var</c>. The directory a session was started in is written onto
/// its instance as a label; in a different spelling from the one git or the
/// shell reports, <c>prune</c> and <c>code</c> stop recognising their own work.
/// </para>
/// <para>
/// The BCL only resolves a link at the end of a path, so this walks the
/// components and resolves each one. A path that does not exist, or that cannot
/// be read, is left as it was: this is a normalisation and not a check.
/// </para>
/// </remarks>
internal static class PhysicalPath
{
    /// <summary>How many links the whole path walk may follow before we stop.</summary>
    /// <remarks>
    /// Targets are walked from their roots too, so all nested walks share this
    /// budget. A cyclic target must not restart the allowance or recurse forever.
    /// </remarks>
    private const int MaxHops = 40;

    public static string Of(string path)
    {
        var remainingHops = MaxHops;
        return Of(path, ref remainingHops);
    }

    private static string Of(string path, ref int remainingHops)
    {
        var full = Path.GetFullPath(path);

        var root = Path.GetPathRoot(full);
        if (string.IsNullOrEmpty(root))
        {
            return full;
        }

        var separators = new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar };
        var current = root;

        foreach (var segment in full[root.Length..].Split(separators, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Resolve(Path.Combine(current, segment), ref remainingHops);
        }

        return current;
    }

    /// <summary>Whether two paths name the same place, links and case aside.</summary>
    public static bool Same(string left, string right) =>
        Of(left).Equals(Of(right), StringComparison.OrdinalIgnoreCase);

    private static string Resolve(string path, ref int remainingHops)
    {
        if (remainingHops > 0)
        {
            string? target;
            try
            {
                // The raw target rather than a resolved one: what it is relative
                // to is decided below, and the framework's own answer to that
                // is not the one we want.
                target = new DirectoryInfo(path).LinkTarget ?? new FileInfo(path).LinkTarget;
            }
            catch (IOException)
            {
                return path;
            }
            catch (UnauthorizedAccessException)
            {
                return path;
            }

            if (target is null)
            {
                return path;
            }

            // A link's target may be relative, and it is relative to the
            // directory the link is in rather than to wherever we were run.
            // A target can itself contain a linked parent, such as /var on
            // macOS. Walk it from its root with the same bounded hop budget.
            remainingHops--;
            path = Of(Path.GetFullPath(target, Path.GetDirectoryName(path) ?? path), ref remainingHops);
        }

        return path;
    }
}
