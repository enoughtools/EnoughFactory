using System.Text.RegularExpressions;

using Envmux.Config;
using Envmux.Lean;
using Envmux.Session;

namespace Envmux.Tests.Ui;

/// <summary>
/// The lean UI, composed.
/// </summary>
/// <remarks>
/// <para>
/// No terminal and no collection to take a turn in. A frame is a function of
/// the session and the view state, so the whole of the lean UI's layout can be
/// asserted on as strings — which is the payoff for it having no toolkit under
/// it, and the reason these run in parallel with everything else while the
/// windowed UI's tests queue for the one screen.
/// </para>
/// <para>
/// Rows carry colour escapes, so every assertion goes through <see cref="Plain"/>
/// first. Asserting on the escapes would be asserting on the palette.
/// </para>
/// </remarks>
public class LeanFrameTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-lean-").FullName;

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

    private Envmux.Session.Session Open() =>
        new(SessionPlan.Resolve(SessionConfig.Load(_dir), _dir, "amber-fox"));

    /// <summary>A row as somebody sees it, with the colour taken back out.</summary>
    private static string Plain(string row) =>
        Regex.Replace(row, "\\[[0-9;?]*[a-zA-Z]", "");

    private static IReadOnlyList<string> Plain(IEnumerable<string> rows) =>
        [.. rows.Select(Plain)];

    [Fact]
    public async Task SaysWhatTheSessionIsAndFillsTheScreen()
    {
        await using var session = Open();
        var frame = LeanFrame.Compose(session, new LeanState(), 100, 30);
        var rows = Plain(frame.Rows);

        // Exactly the height it was given. A frame that is short leaves the
        // previous frame's rows on screen underneath it.
        Assert.Equal(30, rows.Count);

        Assert.Contains("amber-fox", rows[0], StringComparison.Ordinal);
        Assert.Contains("dashboard", rows[0], StringComparison.Ordinal);
        Assert.Contains(SessionConfig.DefaultImage, rows[1], StringComparison.Ordinal);
        Assert.Contains("envmux/amber-fox", rows[2], StringComparison.Ordinal);

        // Two boxes and no third one, the same as the windowed dashboard: the
        // transcript is the open space under them.
        Assert.Equal(2, rows.Count(r => r.Contains('╔', StringComparison.Ordinal)));
        Assert.Contains(rows, r => r.Contains("routes", StringComparison.Ordinal));
        Assert.Contains(rows, r => r.Contains("tasks", StringComparison.Ordinal));
    }

    [Fact]
    public async Task EveryRowStopsAtTheEdge()
    {
        await using var session = Open();

        // A long line that has to be cut somewhere, and a narrow screen to cut
        // it on. A row wider than the terminal wraps, and one wrapped row puts
        // every row under it in the wrong place for the rest of the session.
        session.Log.Info(new string('x', 400));

        var frame = LeanFrame.Compose(session, new LeanState(), 60, 20);

        foreach (var row in Plain(frame.Rows))
        {
            Assert.True(row.Length <= 60, $"{row.Length}: {row}");
        }
    }

    [Fact]
    public async Task TheBoxesAreClosedOnBothSides()
    {
        await using var session = Open();
        var rows = Plain(LeanFrame.Compose(session, new LeanState(), 92, 24).Rows);

        var sides = rows.Where(r => r.StartsWith('║')).ToList();
        Assert.NotEmpty(sides);

        // A rule that runs to the wrong column is silent — nothing throws, the
        // box simply has no right-hand side — so it is worth asserting rather
        // than trusting. It got out once already.
        foreach (var row in sides)
        {
            Assert.Equal(92, row.Length);
            Assert.EndsWith("║", row, StringComparison.Ordinal);
        }

        foreach (var row in rows.Where(r => r.StartsWith('╔') || r.StartsWith('╚')))
        {
            Assert.Equal(92, row.Length);
        }
    }

    [Fact]
    public async Task TheTranscriptShowsTheNewestLineByDefault()
    {
        await using var session = Open();

        for (var i = 1; i <= 200; i++)
        {
            session.Log.Info($"line {i:D3}");
        }

        var rows = Plain(LeanFrame.Compose(session, new LeanState(), 100, 30).Rows);

        Assert.Contains(rows, r => r.Contains("line 200", StringComparison.Ordinal));
        Assert.DoesNotContain(rows, r => r.Contains("line 001", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ScrollingBackHoldsItsPlaceWhileLinesKeepArriving()
    {
        await using var session = Open();

        for (var i = 1; i <= 200; i++)
        {
            session.Log.Info($"line {i:D3}");
        }

        // Twenty rows back from the newest, and then twenty more lines said
        // while somebody is reading there.
        var state = new LeanState { LogScroll = 20 };
        var parked = Plain(LeanFrame.Compose(session, state, 100, 30).Rows)
            .Where(r => r.Contains("line ", StringComparison.Ordinal))
            .ToList();

        Assert.NotEmpty(parked);

        for (var i = 201; i <= 220; i++)
        {
            session.Log.Info($"line {i:D3}");
            state.Logged();
        }

        var still = Plain(LeanFrame.Compose(session, state, 100, 30).Rows)
            .Where(r => r.Contains("line ", StringComparison.Ordinal))
            .ToList();

        // The same lines, in the same order. Not "the newest is absent" —
        // that would also pass if the whole thing had scrolled somewhere else.
        Assert.Equal(parked, still);
        Assert.DoesNotContain(still, r => r.Contains("line 220", StringComparison.Ordinal));
    }

    [Fact]
    public async Task GoingBackToTheEndFollowsAgain()
    {
        await using var session = Open();

        for (var i = 1; i <= 200; i++)
        {
            session.Log.Info($"line {i:D3}");
        }

        var state = new LeanState { LogScroll = 20 };
        _ = LeanFrame.Compose(session, state, 100, 30);

        state.LogScroll = 0;
        session.Log.Info("line 201");
        state.Logged();

        var rows = Plain(LeanFrame.Compose(session, state, 100, 30).Rows);
        Assert.Contains(rows, r => r.Contains("line 201", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ScrollingPastTheStartStops()
    {
        await using var session = Open();

        for (var i = 1; i <= 40; i++)
        {
            session.Log.Info($"line {i:D3}");
        }

        // Further back than there is transcript. The window has to clamp rather
        // than walk off the front and show a screen of nothing.
        var state = new LeanState { LogScroll = 5_000 };
        var rows = Plain(LeanFrame.Compose(session, state, 100, 30).Rows);

        Assert.Contains(rows, r => r.Contains("line 001", StringComparison.Ordinal));
        Assert.True(state.LogScroll < 5_000, "the scroll was never clamped");
    }

    [Fact]
    public async Task TheLogScreenGivesTheTranscriptEverything()
    {
        await using var session = Open();

        for (var i = 1; i <= 200; i++)
        {
            session.Log.Info($"line {i:D3}");
        }

        var dashboard = Lines(new LeanState());
        var full = Lines(new LeanState { Screen = LeanScreen.Log });

        // F2 is the same transcript with the boxes taken away, so it is taller
        // by exactly what the boxes were costing.
        Assert.True(full > dashboard, $"dashboard {dashboard}, log screen {full}");
        Assert.Equal(0, Plain(LeanFrame.Compose(session, new LeanState { Screen = LeanScreen.Log }, 100, 30).Rows)
            .Count(r => r.Contains('╔', StringComparison.Ordinal)));

        int Lines(LeanState state) =>
            Plain(LeanFrame.Compose(session, state, 100, 30).Rows)
                .Count(r => r.Contains("line ", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheCursorIsOnlyThereWhileSomethingIsBeingTyped()
    {
        await using var session = Open();

        Assert.Null(LeanFrame.Compose(session, new LeanState(), 100, 30).Caret);

        var typing = new LeanState { Typing = true, Typed = "/task restart docs" };
        var frame = LeanFrame.Compose(session, typing, 100, 30);

        Assert.NotNull(frame.Caret);
        Assert.Equal(2 + typing.Typed.Length, frame.Caret!.Value.X);
        Assert.Contains(typing.Typed, Plain(frame.Rows[frame.Caret.Value.Y]), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AWindowTooSmallToDrawInSaysSoRatherThanFolding()
    {
        await using var session = Open();
        var rows = Plain(LeanFrame.Compose(session, new LeanState(), 100, 4).Rows);

        Assert.Single(rows);
        Assert.Contains("too small", rows[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task AShortWindowStillLeavesRoomForTheTranscript()
    {
        await using var session = Open();
        session.Log.Info("worktree adopted");

        // Twelve rows: five of chrome and seven for everything else. Both boxes
        // at their natural size would eat all of it, so they have to give way.
        var rows = Plain(LeanFrame.Compose(session, new LeanState(), 100, 12).Rows);

        Assert.Equal(12, rows.Count);
        Assert.Contains(rows, r => r.Contains("worktree adopted", StringComparison.Ordinal));
    }
}
