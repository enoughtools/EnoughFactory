using System.Text;
using System.Text.Json;

using Envmux.Process;

namespace Envmux.Host.Windows;

/// <summary>A PowerShell command that ran and did not do what was asked.</summary>
internal sealed class PowershellException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The one thing on Windows there is no API for: Hyper-V and the resolver policy.
/// </summary>
/// <remarks>
/// <para>
/// <c>New-VM</c>, <c>Enable-VMTPM</c>, <c>Convert-VHD</c> and
/// <c>Add-DnsClientNrptRule</c> are cmdlets over WMI providers with no stable
/// managed surface. Driving them as a subprocess is the same decision the rest
/// of envmux makes about <c>git</c>: the tool is already installed on any
/// machine this can run on, and reimplementing it would be a second
/// implementation to keep correct.
/// </para>
/// <para>
/// Everything crossing this boundary goes as JSON — <c>ConvertTo-Json</c> out,
/// parameters through a here-string in, never string-concatenated into a
/// command line. A VM name with a space in it is not an exotic case.
/// </para>
/// </remarks>
internal static class Powershell
{
    /// <summary>
    /// Windows PowerShell rather than PowerShell 7, deliberately.
    /// </summary>
    /// <remarks>
    /// The Hyper-V module is shipped with the Windows feature and loads natively
    /// in Windows PowerShell. In PowerShell 7 it loads through the compatibility
    /// layer, which works and is slower and occasionally reports objects that
    /// have been through serialisation. <c>powershell.exe</c> is present on
    /// every Windows 11 install; <c>pwsh</c> is not.
    /// </remarks>
    private const string Executable = "powershell.exe";

    /// <summary>Whether this is even a machine that has PowerShell.</summary>
    public static bool IsAvailable => OperatingSystem.IsWindows();

    /// <summary>
    /// Run a script and hand back what it wrote.
    /// </summary>
    /// <remarks>
    /// <c>-NonInteractive</c> matters more than it looks: a cmdlet that decides
    /// to prompt — for confirmation, for a missing mandatory parameter — would
    /// otherwise wait forever on a console nobody is attached to.
    /// </remarks>
    public static async Task<ProcessResult> RunAsync(
        string script,
        IReadOnlyDictionary<string, string>? parameters = null,
        CancellationToken ct = default)
    {
        if (!IsAvailable)
        {
            throw new PowershellException(
                "the Hyper-V host is built with PowerShell, which means this step only runs on Windows");
        }

        var full = new StringBuilder();

        // A cmdlet that writes a non-terminating error otherwise carries on and
        // reports success, which for `New-VM` means a VM that does not exist and
        // an exit code of zero.
        full.AppendLine("$ErrorActionPreference = 'Stop'");
        full.AppendLine("$ProgressPreference = 'SilentlyContinue'");

        foreach (var (name, value) in parameters ?? new Dictionary<string, string>(StringComparer.Ordinal))
        {
            // A single-quoted here-string: nothing inside is expanded, so a
            // value containing $, a backtick, or a quote arrives intact.
            full.AppendLine($"${name} = @'");
            full.AppendLine(value.ReplaceLineEndings("\n"));
            full.AppendLine("'@");
        }

        // Wrapped, because a terminating error otherwise reaches this process
        // as CLIXML on stderr — PowerShell serialises its error records when the
        // stream is redirected, and what a person then reads is forty lines of
        // XML around one sentence. Caught here, the sentence comes back on
        // stdout with a marker in front of it and nothing else.
        full.AppendLine("try {");
        full.AppendLine(script);
        full.AppendLine("} catch {");
        full.AppendLine($"  Write-Output ('{Marker}' + $_.Exception.Message)");
        full.AppendLine("  exit 1");
        full.AppendLine("}");

        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(full.ToString()));

        var result = await ProcessRunner.RunAsync(
            Executable,
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            ct: ct).ConfigureAwait(false);

        return Unwrap(result);
    }

    /// <summary>What a caught error is prefixed with, so it can be told from output.</summary>
    private const string Marker = "envmux-powershell-error: ";

    /// <summary>
    /// Take the marker line out of stdout and make it the error.
    /// </summary>
    /// <remarks>
    /// So callers read <see cref="ProcessResult.Error"/> and get a sentence
    /// rather than a serialised error record, and read
    /// <see cref="ProcessResult.Output"/> and get only what the script actually
    /// wrote — which matters for the ones that end in <c>ConvertTo-Json</c>.
    /// </remarks>
    private static ProcessResult Unwrap(ProcessResult result)
    {
        var lines = result.Stdout.ReplaceLineEndings("\n").Split('\n');
        var error = lines.FirstOrDefault(l => l.StartsWith(Marker, StringComparison.Ordinal));

        if (error is null)
        {
            return result with { Stderr = Readable(result.Stderr) };
        }

        return new ProcessResult(
            result.ExitCode == 0 ? 1 : result.ExitCode,
            string.Join('\n', lines.Where(l => !l.StartsWith(Marker, StringComparison.Ordinal))),
            error[Marker.Length..]);
    }

    /// <summary>
    /// Strip the CLIXML wrapper off anything that escaped the try.
    /// </summary>
    /// <remarks>
    /// A best-effort second line of defence: a native executable writing to
    /// stderr, or a cmdlet erroring non-terminatingly, still arrives serialised.
    /// The text is inside <c>&lt;S&gt;</c> elements with encoded newlines.
    /// </remarks>
    private static string Readable(string stderr)
    {
        if (!stderr.StartsWith("#< CLIXML", StringComparison.Ordinal))
        {
            return stderr;
        }

        var text = System.Text.RegularExpressions.Regex.Replace(stderr, "<[^>]+>", "");

        return System.Net.WebUtility.HtmlDecode(text)
            .Replace("_x000D_", "", StringComparison.Ordinal)
            .Replace("_x000A_", "\n", StringComparison.Ordinal)
            .Replace("#< CLIXML", "", StringComparison.Ordinal)
            .Trim();
    }

    /// <summary>Run a script, and throw with its own error text when it fails.</summary>
    public static async Task<string> CheckedAsync(
        string script,
        IReadOnlyDictionary<string, string>? parameters = null,
        CancellationToken ct = default)
    {
        var result = await RunAsync(script, parameters, ct).ConfigureAwait(false);

        return result.Ok
            ? result.Output
            : throw new PowershellException(result.Error.ReplaceLineEndings(" ").Trim());
    }

    /// <summary>Run a script that ends in <c>ConvertTo-Json</c> and parse what came back.</summary>
    public static async Task<JsonElement> JsonAsync(
        string script,
        IReadOnlyDictionary<string, string>? parameters = null,
        CancellationToken ct = default)
    {
        var output = await CheckedAsync(script, parameters, ct).ConfigureAwait(false);

        if (output.Trim().Length == 0)
        {
            return default;
        }

        try
        {
            using var document = JsonDocument.Parse(output);
            return document.RootElement.Clone();
        }
        catch (JsonException e)
        {
            throw new PowershellException($"PowerShell did not answer with JSON: {Truncate(output)}", e);
        }
    }

    /// <summary>Whether a cmdlet exists on this machine — which is how a missing feature is detected.</summary>
    public static async Task<bool> HasCommandAsync(string name, CancellationToken ct = default)
    {
        var result = await RunAsync(
            $"if (Get-Command '{name}' -ErrorAction SilentlyContinue) {{ 'yes' }} else {{ 'no' }}",
            ct: ct).ConfigureAwait(false);

        return result.Ok && result.Output.Trim() == "yes";
    }

    /// <summary>Whether this process can do the elevated half of the wiring.</summary>
    public static async Task<bool> IsElevatedAsync(CancellationToken ct = default)
    {
        var result = await RunAsync(
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
            ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
            ct: ct).ConfigureAwait(false);

        return result.Ok && result.Output.Trim().Equals("True", StringComparison.OrdinalIgnoreCase);
    }

    private static string Truncate(string s) =>
        s.ReplaceLineEndings(" ") is { Length: > 200 } long_ ? long_[..200] + "…" : s.ReplaceLineEndings(" ");
}
