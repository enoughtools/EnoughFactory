namespace Envmux.Lean;

/// <summary>Starting the UI failed, and the terminal has been handed back.</summary>
internal sealed class UiException(string message, Exception inner)
    : Exception(message, inner);

/// <summary>
/// Putting the UI on the terminal, and taking it off again.
/// </summary>
/// <remarks>
/// <para>
/// One call that returns when the user quits, one exception type when it
/// cannot start, and the session torn down by the caller either way. Program
/// needs to know nothing else about it.
/// </para>
/// <para>
/// No thread of its own. There is no dispatcher to own and no apartment to be
/// in — the loop runs wherever it is awaited, and the only thing it insists on
/// is that it is the only thing writing to the terminal.
/// </para>
/// </remarks>
internal static class LeanHost
{
    /// <exception cref="UiException">The UI could not be started.</exception>
    public static async Task RunAsync(Session.Session session)
    {
        LeanConsole? console = null;

        try
        {
            console = new LeanConsole();

            using var shell = new LeanShell(session, console);
            await shell.RunAsync().ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            throw new UiException($"the UI could not be started: {e.Message}", e);
        }
        finally
        {
            // Before anything else prints. The console has been switched to
            // its alternate screen by now and whatever is being reported —
            // a failure here, or the session's own report — arrives on the
            // screen the person is actually looking at.
            console?.Dispose();
        }
    }
}
