using System.Text;

namespace Envmux;

/// <summary>
/// Building a script for the other side of the machine boundary.
/// </summary>
/// <remarks>
/// <para>
/// One method, for one reason: <see cref="StringBuilder.AppendLine()"/> ends a
/// line with <see cref="Environment.NewLine"/>, which on Windows is CRLF. Every
/// script envmux builds is run by a POSIX shell in a Linux guest, where a
/// trailing carriage return is part of the last word on the line — so
/// <c>set -eu</c> is read as <c>set -eu\r</c> and dash answers
/// <c>set: Illegal option -</c>, which is what the golden build failed with.
/// </para>
/// <para>
/// It is worse when it does not fail. <c>cd /work\r</c> is a directory that does
/// not exist, <c>VAR=value\r</c> is a value with a control character on the end,
/// and a comparison against it quietly stops matching. The build that broke was
/// the lucky case.
/// </para>
/// <para>
/// So: never <c>AppendLine</c> in a script that leaves this machine. This makes
/// the right thing as short to write as the wrong one.
/// </para>
/// </remarks>
internal static class Shell
{
    /// <summary>What ends a line on the far side, whatever ends one here.</summary>
    public const char Newline = '\n';

    /// <summary>Append a line of shell, ended the way a shell ends one.</summary>
    /// <param name="script">The script being built.</param>
    /// <param name="line">One line, without its terminator.</param>
    public static StringBuilder Line(this StringBuilder script, string line) =>
        script.Append(line).Append(Newline);

    /// <summary>An empty line, for a script worth reading.</summary>
    /// <param name="script">The script being built.</param>
    public static StringBuilder Line(this StringBuilder script) =>
        script.Append(Newline);
}
