namespace Envmux.Commands;

/// <summary>
/// What this binary was actually invoked as.
/// </summary>
/// <remarks>
/// <para>
/// Every instruction envmux prints for somebody else to run has to name the
/// command that printed it, not the name the source happens to use. A
/// development build installed as <c>devenvmux</c>, a binary renamed on a
/// PATH, a tool run by absolute path — in all of them a hardcoded "envmux"
/// sends the reader to a different program.
/// </para>
/// <para>
/// This is not hypothetical. An agent handed a prompt that said
/// <c>envmux config validate</c> ran exactly that, reached an unrelated older
/// envmux still installed on the machine, and concluded — reasonably — that the
/// prompt was wrong and wrote a config for the other tool instead.
/// </para>
/// </remarks>
internal static class CommandName
{
    private static string? _cached;

    /// <summary>The command to tell people to run.</summary>
    /// <remarks>
    /// Except when the process is the runtime host. Run as <c>dotnet
    /// envmux.dll</c> — how a build is tried out before it is installed — the
    /// process is <c>dotnet</c>, and "<c>dotnet host prepare | Set-Clipboard</c>"
    /// is an instruction that runs something, just nothing of ours. There the
    /// product's own name is the least wrong thing to print.
    /// </remarks>
    public static string Current => _cached ??= From(Environment.ProcessPath);

    /// <summary>The name to print, given the path of the process that is running.</summary>
    internal static string From(string? processPath) =>
        Path.GetFileNameWithoutExtension(processPath?.Replace('\\', '/')) is { Length: > 0 } name &&
        !name.Equals("dotnet", StringComparison.OrdinalIgnoreCase)
            ? name
            : "envmux";

    /// <summary>Override, for tests.</summary>
    internal static void OverrideForTesting(string? name) => _cached = name;
}
