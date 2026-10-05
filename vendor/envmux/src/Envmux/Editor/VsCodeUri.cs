using System.Text;

namespace Envmux.Editor;

/// <summary>An editor could not be found, launched, or addressed.</summary>
internal sealed class EditorException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The <c>vscode-remote://ssh-remote+…</c> URI an editor is pointed at.
/// </summary>
/// <remarks>
/// <para>
/// <c>ssh-remote+&lt;user&gt;@&lt;host&gt;/&lt;PATH&gt;</c>, where <c>PATH</c> is
/// the absolute folder on the far side, percent-encoded with an allow-list that
/// never touches <c>/</c>.
/// </para>
/// <para>
/// This replaced <c>attached-container+&lt;HEX&gt;</c>, which named a container
/// on the local engine and encoded that name as the lowercase hex of a compact
/// JSON payload. That format is undocumented — VS Code has never published it
/// (vscode-remote-release#5867) — and it lived here behind reference vectors so
/// that a change to it would be a failing test rather than a bug report six
/// weeks later. There is no local engine, so it is gone; this one is documented,
/// which is the pleasant half of the trade.
/// </para>
/// </remarks>
internal static class VsCodeUri
{
    /// <summary>
    /// Percent-encode a path on the far side, leaving the separators alone.
    /// </summary>
    /// <remarks>
    /// Allow-list <c>[A-Za-z0-9-._~/]</c>, per RFC 3986's unreserved set plus
    /// the separator. <c>/</c> is never encoded — it is the path structure, not
    /// content — and everything else is encoded per UTF-8 byte in uppercase.
    /// </remarks>
    internal static string EncodePath(string path)
    {
        var encoded = new StringBuilder(path.Length);

        foreach (var b in Encoding.UTF8.GetBytes(path))
        {
            if (char.IsAsciiLetterOrDigit((char)b) || b is (byte)'-' or (byte)'.' or (byte)'_' or (byte)'~' or (byte)'/')
            {
                encoded.Append((char)b);
            }
            else
            {
                encoded.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        return encoded.ToString();
    }

    /// <summary>
    /// The folder URI for a machine reached over SSH.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What replaces the attached-container form. That one worked by naming a
    /// container on the local engine, and there is no local engine: the instance
    /// is on another machine, reached by a name that resolves. So the editor
    /// connects to it the way it would to any other remote development box.
    /// </para>
    /// <para>
    /// <c>ssh-remote+&lt;authority&gt;&lt;path&gt;</c>. This one <em>is</em>
    /// documented, which is the pleasant part of the trade — the undocumented
    /// hex payload above stops being load-bearing.
    /// </para>
    /// </remarks>
    public static string SshFolderUri(string user, string hostname, string folder)
    {
        var authority = NormalizeSshAuthority(user, hostname);
        var absolute = folder.StartsWith('/') ? folder : "/" + folder;

        return $"vscode-remote://ssh-remote+{authority}{EncodePath(absolute)}";
    }

    /// <summary>
    /// Check a user and hostname before they are put in a URI.
    /// </summary>
    /// <remarks>
    /// Same reasoning as the container name: on Windows the editor is usually a
    /// <c>.cmd</c>, which is run through a command interpreter, so a value that
    /// smuggled metacharacters would reach one. The answer is rejection, not
    /// escaping.
    /// </remarks>
    /// <exception cref="EditorException">Either part is not something that could be an SSH target.</exception>
    internal static string NormalizeSshAuthority(string user, string hostname)
    {
        var account = user.Trim();
        var host = hostname.Trim().TrimEnd('.');

        var validUser = account.Length > 0 &&
                        account.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-');

        var validHost = host.Length > 0 &&
                        char.IsAsciiLetterOrDigit(host[0]) &&
                        host.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-');

        return validUser && validHost
            ? $"{account}@{host}"
            : throw new EditorException($"'{user}@{hostname}' is not an SSH target an editor can be pointed at");
    }
}
