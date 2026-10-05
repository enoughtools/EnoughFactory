namespace Envmux.Config;

/// <summary>
/// A <c>.env</c> file on this machine, read for the session's environment.
/// </summary>
/// <remarks>
/// <para>
/// The gap this fills: a project's local secrets are usually in a gitignored
/// <c>.env</c>, which means they are on the host and — by design — not in the
/// bundle. So a session gets the repository and none of what makes it run. five80
/// found it: <c>bun install</c> died on
/// <c>error: invalid _auth value, expected valid base64</c> because its
/// <c>.npmrc</c> reads <c>${ELMO_JFROG_AUTH}</c>, which lives in a file git was
/// told to ignore.
/// </para>
/// <para>
/// Named in the config rather than found, and for the same reason the coding
/// tools are: this is a file of secrets leaving the machine, and it should
/// happen because somebody asked rather than because envmux went looking for
/// dotfiles.
/// </para>
/// <para>
/// Deliberately a small parser. <c>KEY=value</c>, <c>#</c> comments, optional
/// <c>export</c>, and quotes stripped when they wrap the whole value. No
/// interpolation and no multi-line values: this reads the file a shell would
/// source, not every file a shell could.
/// </para>
/// </remarks>
internal static class DotEnv
{
    /// <summary>
    /// Read one file into name/value pairs, in the order it wrote them.
    /// </summary>
    /// <remarks>
    /// A file that is not there is empty rather than an error. The declaration
    /// is about a machine, and the machine that has no <c>.env</c> is a machine
    /// where the project has not been set up yet — which is a better message
    /// from whatever needed the value than from here.
    /// </remarks>
    /// <param name="path">Where the file is.</param>
    public static IReadOnlyList<KeyValuePair<string, string>> Read(string path)
    {
        if (!File.Exists(path))
        {
            return [];
        }

        var values = new List<KeyValuePair<string, string>>();

        foreach (var raw in File.ReadLines(path))
        {
            if (Parse(raw) is { } pair)
            {
                values.Add(pair);
            }
        }

        return values;
    }

    /// <summary>One line, or null when it holds nothing.</summary>
    /// <param name="raw">The line as written.</param>
    internal static KeyValuePair<string, string>? Parse(string raw)
    {
        var line = raw.Trim();

        if (line.Length == 0 || line.StartsWith('#'))
        {
            return null;
        }

        // `export FOO=bar` is a .env that is also sourceable, which is common.
        if (line.StartsWith("export ", StringComparison.Ordinal))
        {
            line = line["export ".Length..].TrimStart();
        }

        var split = line.IndexOf('=', StringComparison.Ordinal);

        if (split <= 0)
        {
            return null;
        }

        var name = line[..split].Trim();
        var value = line[(split + 1)..].Trim();

        if (name.Length == 0)
        {
            return null;
        }

        // Only when they wrap the whole thing. A value that merely contains a
        // quote keeps it, because taking it out would change the secret.
        if (value.Length >= 2 &&
            ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
        {
            value = value[1..^1];
        }

        return new KeyValuePair<string, string>(name, value);
    }
}
