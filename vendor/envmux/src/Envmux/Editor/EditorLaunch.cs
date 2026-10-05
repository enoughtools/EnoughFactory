using System.Diagnostics;

namespace Envmux.Editor;

/// <summary>Exactly what will be executed — built once, so a test can read it.</summary>
/// <param name="Editor">The program.</param>
/// <param name="Uri">The folder URI, which is always a single argument.</param>
/// <param name="NewWindow">Whether to pass <c>--new-window</c>.</param>
/// <param name="Environment">
/// Extra environment for the editor process, or null. Nothing needs it now that
/// the attach is SSH; it was <c>DOCKER_HOST</c>, so the editor's own engine
/// calls reached the daemon the container was started in.
/// </param>
internal sealed record LaunchPlan(
    string Editor,
    string Uri,
    bool NewWindow,
    IReadOnlyDictionary<string, string>? Environment = null)
{
    /// <summary>
    /// The arguments after the program.
    /// </summary>
    /// <remarks>
    /// The URI is its own element and <c>--folder-uri</c> is its own element —
    /// never joined with <c>=</c>, never a single string for something else to
    /// re-split. It contains percent-encoding, and a round trip through any
    /// interpreter is a chance for that to be mangled.
    /// </remarks>
    public IReadOnlyList<string> Arguments =>
        NewWindow ? ["--new-window", "--folder-uri", Uri] : ["--folder-uri", Uri];
}

/// <summary>
/// Spawning the editor: hand off and get out of the way.
/// </summary>
/// <remarks>
/// The editor is a GUI with its own lifetime and envmux's job ends at a
/// successful spawn — never <c>--wait</c>, never a blocked UI. Whether the
/// connection then works is between VS Code and the instance, in VS Code's window.
/// </remarks>
internal static class EditorLaunch
{
    /// <summary>
    /// Start the editor and stop caring about it.
    /// </summary>
    /// <param name="onExit">
    /// Called if it exits non-zero, with whatever it said. A late warning rather
    /// than a failure: an editor that starts and then gives up has already taken
    /// the launch out of envmux's hands.
    /// </param>
    /// <exception cref="EditorException">It could not be started at all.</exception>
    public static void Start(LaunchPlan plan, Action<string> onExit)
    {
        var info = new ProcessStartInfo
        {
            FileName = plan.Editor,

            // No shell. The URI travels as one argument through the argument
            // list, which is also what keeps .NET's escaping — including its
            // handling of Windows .cmd shims — responsible for quoting it.
            UseShellExecute = false,
            RedirectStandardInput = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        foreach (var argument in plan.Arguments)
        {
            info.ArgumentList.Add(argument);
        }

        foreach (var (key, value) in plan.Environment ?? new Dictionary<string, string>(StringComparer.Ordinal))
        {
            info.Environment[key] = value;
        }

        System.Diagnostics.Process process;
        try
        {
            process = System.Diagnostics.Process.Start(info)
                ?? throw new EditorException($"{plan.Editor} did not start");
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new EditorException($"could not start {plan.Editor}: {e.Message}", e);
        }

        // Detached on purpose. Something has to collect the exit status or the
        // child zombies, and nothing may block the UI waiting for an editor
        // somebody is about to spend the afternoon in.
        _ = Task.Run(async () =>
        {
            using (process)
            {
                var stderr = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync().ConfigureAwait(false);

                if (process.ExitCode == 0)
                {
                    return;
                }

                var said = (await stderr.ConfigureAwait(false)).Trim().ReplaceLineEndings(" ");
                onExit(said.Length > 0
                    ? $"the editor exited {process.ExitCode}: {Truncate(said)}"
                    : $"the editor exited {process.ExitCode}");
            }
        });
    }

    private static string Truncate(string s) => s.Length > 200 ? s[..200] + "…" : s;
}
