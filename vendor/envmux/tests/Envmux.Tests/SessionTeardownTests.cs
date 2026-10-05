using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// Taking a session down, however many times it is asked.
/// </summary>
/// <remarks>
/// Three separate things want to be sure teardown happened — the normal exit,
/// the <c>await using</c> around the session, and the process-exit handler that
/// exists for the ways a process ends without either. They all call the same
/// method, and it has to be safe for two of them to be redundant.
/// </remarks>
public class SessionTeardownTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-stop-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private Session.Session Open() =>
        new(SessionPlan.Resolve(SessionConfig.Load(_dir), _dir, "amber-fox"));

    [Fact]
    public async Task StoppingTwiceIsStoppingOnce()
    {
        var session = Open();

        // Nothing was started, so the interesting part is that the second call
        // does not go back to git for a worktree that has already been handed
        // back — during shutdown, where the deadline is not ours.
        var first = await session.StopAsync().ConfigureAwait(true);
        var second = await session.StopAsync().ConfigureAwait(true);

        Assert.Equal(first, second);

        await session.DisposeAsync().ConfigureAwait(true);
    }

    [Fact]
    public async Task DisposingAfterStoppingIsQuiet()
    {
        var session = Open();

        await session.StopAsync().ConfigureAwait(true);

        // The `await using` in Program runs after the explicit stop. It has to
        // be a no-op rather than a second teardown.
        await session.DisposeAsync().ConfigureAwait(true);
        await session.DisposeAsync().ConfigureAwait(true);
    }
}
