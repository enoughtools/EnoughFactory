using System.Text.RegularExpressions;

namespace Envmux.Session;

/// <summary>
/// Watches a task's output for the URL it said would be in there.
/// </summary>
/// <remarks>
/// <para>
/// The first line that matches wins and the rest are ignored. A server prints
/// its address once, as it comes up, and a token printed then is the token
/// that works; a second match later in the same run is far more likely to be a
/// request log quoting the URL than a new one. A restart is the exception —
/// the server minted a new token and printed it — so the task resets this at
/// the start of every run.
/// </para>
/// <para>
/// The pattern is the person's, and a person's regular expression run against
/// every line a build produces is a person's regular expression run against a
/// stack trace. It is compiled with a match timeout for that reason, and a
/// timeout is treated as a line that did not match rather than as an error: a
/// pathological line should cost a quarter of a second, not the task.
/// </para>
/// </remarks>
internal sealed class UrlCapture(Regex pattern)
{
    /// <summary>What was found, as printed. Null until a line has matched.</summary>
    public string? Url { get; private set; }

    /// <summary>
    /// Look at one line of output.
    /// </summary>
    /// <returns>True when this is the line, and <see cref="Url"/> has just been set.</returns>
    public bool Observe(string line)
    {
        if (Url is not null)
        {
            return false;
        }

        Match match;

        try
        {
            match = pattern.Match(line);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }

        if (!match.Success)
        {
            return false;
        }

        // The first group when there is one, so the pattern can carry the
        // words around the URL that make it unambiguous — "Login to the
        // dashboard at (https://\S+)" — and the whole match when there is not.
        var found = match.Groups.Count > 1 && match.Groups[1].Success
            ? match.Groups[1].Value
            : match.Value;

        found = found.Trim();

        if (found.Length == 0)
        {
            return false;
        }

        Url = found;
        return true;
    }

    /// <summary>Forget it, because the task is starting again and will print a new one.</summary>
    public void Reset() => Url = null;
}
