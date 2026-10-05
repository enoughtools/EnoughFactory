using System.Text;

namespace Envmux.Config;

/// <summary>
/// Turns a directory name into something that can be the first label of a
/// hostname.
/// </summary>
internal static class Slug
{
    /// <summary>
    /// Lowercase, ASCII letters and digits kept, everything else collapsed to a
    /// single hyphen, no leading or trailing hyphen, truncated to a DNS label's
    /// 63 characters.
    /// </summary>
    /// <remarks>
    /// Hyphens are collapsed rather than preserved because the hostname shape is
    /// <c>{name}-{route}.{domain}</c>: a name ending in a hyphen would produce a
    /// double separator, and one containing a run of them makes the URL harder
    /// to read for no gain. A name that slugs away to nothing falls back to
    /// <c>envmux</c> rather than producing a hostname starting with a hyphen.
    /// </remarks>
    public static string From(string input)
    {
        var sb = new StringBuilder(input.Length);
        var pendingHyphen = false;

        foreach (var c in input)
        {
            if (char.IsAsciiLetterOrDigit(c))
            {
                if (pendingHyphen && sb.Length > 0)
                {
                    sb.Append('-');
                }

                pendingHyphen = false;
                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                pendingHyphen = true;
            }
        }

        var slug = sb.ToString();
        if (slug.Length > 63)
        {
            slug = slug[..63].TrimEnd('-');
        }

        return slug.Length == 0 ? "envmux" : slug;
    }

    /// <summary>The slug for the directory a session was started in.</summary>
    public static string FromDirectory(string directory) =>
        From(new DirectoryInfo(Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory))).Name);
}
