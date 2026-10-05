using System.Diagnostics;
using System.Text;

namespace Envmux.Process;

/// <summary>What a finished process left behind.</summary>
internal sealed record ProcessResult(int ExitCode, string Stdout, string Stderr)
{
    public bool Ok => ExitCode == 0;

    /// <summary>Stdout with the trailing newline every CLI adds removed.</summary>
    public string Output => Stdout.TrimEnd('\r', '\n');

    /// <summary>
    /// The most useful thing to show a human when this failed.
    /// </summary>
    /// <remarks>
    /// Falls back to stdout because a caught PowerShell error is written there,
    /// and an error message of "" is worse than the wrong stream.
    /// </remarks>
    public string Error =>
        Stderr.Trim() is { Length: > 0 } e ? e : Stdout.Trim();
}

/// <summary>A command that ran and failed, with the failure attached.</summary>
internal sealed class ProcessException(string file, ProcessResult result)
    : Exception($"{file} exited {result.ExitCode}: {result.Error}")
{
    public ProcessResult Result { get; } = result;
}

/// <summary>
/// Runs <c>git</c> and <c>powershell</c>, which is the whole of envmux's contact
/// with this machine.
/// </summary>
/// <remarks>
/// <para>
/// Both are driven as subprocesses rather than through libraries. It is one code
/// path on every platform, and both are already installed on any machine that
/// can run this.
/// </para>
/// <para>
/// Everything else — instances, execs, files — goes over the Incus API, which is
/// a real network protocol to a real machine and not something a subprocess
/// could stand in for.
/// </para>
/// </remarks>
internal static class ProcessRunner
{
    /// <summary>Run a command, capturing both streams.</summary>
    /// <param name="file">The executable.</param>
    /// <param name="args">Its arguments, unquoted and unescaped.</param>
    /// <param name="workingDirectory">Where to run it. Defaults to this process's.</param>
    /// <param name="env">Extra environment, on top of this process's.</param>
    /// <param name="stdin">
    /// What to write to its input, or null to give it none. Only for the
    /// commands that read a request rather than take arguments -- `git
    /// credential fill` is the one here, and it wants a key=value block.
    /// </param>
    /// <param name="ct">Cancellation.</param>
    public static async Task<ProcessResult> RunAsync(
        string file,
        IEnumerable<string> args,
        string? workingDirectory = null,
        IReadOnlyDictionary<string, string>? env = null,
        string? stdin = null,
        CancellationToken ct = default)
    {
        var info = new ProcessStartInfo
        {
            FileName = file,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = stdin is not null,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory ?? Environment.CurrentDirectory,
        };

        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        foreach (var (key, value) in env ?? new Dictionary<string, string>())
        {
            info.Environment[key] = value;
        }

        using var process = new System.Diagnostics.Process { StartInfo = info };

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) { stdout.AppendLine(e.Data); } };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) { stderr.AppendLine(e.Data); } };

        try
        {
            process.Start();
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            // The tool is not on PATH. Saying which one is missing is the whole
            // difference between a fixable message and a stack trace.
            throw new ProcessException(file, new ProcessResult(127, "", $"{file} not found on PATH: {e.Message}"));
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        if (stdin is not null)
        {
            // Closed, not just flushed: a command that reads until end of input
            // waits forever for a stream that is merely quiet.
            await process.StandardInput.WriteAsync(stdin.AsMemory(), ct).ConfigureAwait(false);
            process.StandardInput.Close();
        }

        await process.WaitForExitAsync(ct).ConfigureAwait(false);

        return new ProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString());
    }

    /// <summary>Run a command, and throw if it fails.</summary>
    public static async Task<ProcessResult> CheckedAsync(
        string file,
        IEnumerable<string> args,
        string? workingDirectory = null,
        IReadOnlyDictionary<string, string>? env = null,
        CancellationToken ct = default)
    {
        var result = await RunAsync(file, args, workingDirectory, env, null, ct).ConfigureAwait(false);
        return result.Ok ? result : throw new ProcessException(file, result);
    }

    /// <summary>Whether a tool is on <c>PATH</c> and answers at all.</summary>
    public static async Task<bool> ExistsAsync(string file, string versionArg = "--version")
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            return (await RunAsync(file, [versionArg], ct: cts.Token).ConfigureAwait(false)).Ok;
        }
        catch (Exception e) when (e is ProcessException or OperationCanceledException)
        {
            return false;
        }
    }
}
