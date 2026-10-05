using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The log, and the one thing it must never do.
/// </summary>
/// <remarks>
/// A headless run subscribes with <c>Console.WriteLine</c>. Interrupt a session
/// whose output is piped somewhere and the reader can die first, so the next
/// write throws on a broken pipe — during teardown, which is when the session's
/// commits are being brought back out of the instance. The work would stay
/// behind and the console would say nothing about it, because the console is
/// what broke.
/// </remarks>
public class SessionLogTests
{
    /// <summary>A subscriber that throws does not become the caller's problem.</summary>
    [Fact]
    public void ABrokenConsoleDoesNotStopTheThingBeingLogged()
    {
        var log = new SessionLog();
        log.Appended += _ => throw new IOException("the pipe has been ended");

        // The assertion is that this returns at all.
        log.Info("bringing 1 commit back");

        Assert.Single(log.Entries);
        Assert.Equal("bringing 1 commit back", log.Entries[0].Message);
    }

    /// <summary>And the subscribers after it still hear about it.</summary>
    /// <remarks>
    /// The TUI and a file logger can be subscribed at once. One console going
    /// away must not silence the rest.
    /// </remarks>
    [Fact]
    public void OneBrokenSubscriberDoesNotSilenceTheOthers()
    {
        var log = new SessionLog();
        var heard = new List<string>();

        log.Appended += _ => throw new IOException("the pipe has been ended");
        log.Appended += entry => heard.Add(entry.Message);

        log.Info("first");
        log.Warn("second");

        Assert.Equal(["first", "second"], heard);
    }

    /// <summary>
    /// A subscriber that throws something unexpected still throws.
    /// </summary>
    /// <remarks>
    /// Only the failures a vanished console produces are swallowed. Anything
    /// else in a subscriber is a bug, and a log that hides bugs is worse than
    /// one that can be interrupted.
    /// </remarks>
    [Fact]
    public void ARealBugInASubscriberIsStillABug()
    {
        var log = new SessionLog();
        log.Appended += _ => throw new FormatException("a real mistake");

        Assert.Throws<FormatException>(() => log.Info("anything"));
    }

    /// <summary>
    /// The task-output event is isolated the same way.
    /// </summary>
    /// <remarks>
    /// It is raised from inside the loop following a task's log, where a throw
    /// would end the follower and with it ever learning what the task exited
    /// with.
    /// </remarks>
    [Fact]
    public void ABrokenConsoleDoesNotStopATasksOutput()
    {
        var log = new SessionLog();
        var heard = new List<string>();

        log.Appended += _ => throw new IOException("the pipe has been ended");
        log.Appended += entry => heard.Add(entry.Message);

        // Three in a row: a subscriber that throws every time must not
        // eventually be the one that wins.
        log.Info("one");
        log.Info("two");
        log.Info("three");

        Assert.Equal(["one", "two", "three"], heard);
    }

    /// <summary>The ring is bounded, so a session that runs all day does not grow.</summary>
    [Fact]
    public void TheLogIsBounded()
    {
        var log = new SessionLog();

        for (var i = 0; i < 600; i++)
        {
            log.Debug($"line {i.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }

        Assert.True(log.Entries.Count <= 500, $"kept {log.Entries.Count}");
        Assert.Equal("line 599", log.Entries[^1].Message);
    }
}
