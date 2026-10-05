using Envmux.Agents;

namespace Envmux.Tests;

/// <summary>
/// The room as a feed: cursors, deltas, and waking a waiter.
/// </summary>
/// <remarks>
/// On a real directory, because the thing under test is reading files other
/// processes write. What is worth pinning down is that a follower asking with
/// the cursor it was last handed sees every line exactly once — across the
/// quarter-hour rollover, which is where a cursor that named only a file would
/// stop — and that a waiter is woken by an append rather than left to the timer.
/// </remarks>
public sealed class RoomFeedTests : IDisposable
{
    private readonly string _repo = Directory.CreateTempSubdirectory("envmux-feed-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);

        try
        {
            Directory.Delete(_repo, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private string Bucket(string relative) =>
        Path.Combine(Chatroom.Root(_repo), relative.Replace('/', Path.DirectorySeparatorChar));

    private Task WriteAsync(string relative, params string[] lines) =>
        Chatroom.AppendLinesAsync(Bucket(relative), lines);

    [Theory]
    [InlineData("", "", 0)]
    [InlineData("2026-09-03/1115.txt:12", "2026-09-03/1115.txt", 12)]
    [InlineData("2026-09-03.txt:0", "2026-09-03.txt", 0)]
    public void ReadsACursorBackFromItsOwnSpelling(string text, string bucket, int count)
    {
        Assert.True(RoomCursor.TryParse(text, out var cursor));
        Assert.Equal(bucket, cursor.Bucket);
        Assert.Equal(count, cursor.Count);
        Assert.Equal(text, cursor.ToString());
    }

    /// <summary>A cursor names a file under the room and nothing else: no escaping the directory, no nonsense.</summary>
    [Theory]
    [InlineData("nope")]
    [InlineData("2026-09-03/1115.txt:-1")]
    [InlineData("2026-09-03/1115.txt:x")]
    [InlineData("../secrets:1")]
    [InlineData("2026-09-03/../../etc/passwd:1")]
    [InlineData("/etc/passwd:1")]
    [InlineData(":3")]
    public void RefusesACursorThatIsNotOne(string text) =>
        Assert.False(RoomCursor.TryParse(text, out _));

    [Fact]
    public async Task HandsBackEverythingAfterACursorAndWhereThatLeavesIt()
    {
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one", "[11:17] chef: two", "[11:18] chef: three");

        using var feed = new RoomFeed(_repo);

        var delta = feed.After(new RoomCursor("2026-09-03/1115.txt", 1));

        Assert.Equal(["[11:17] chef: two", "[11:18] chef: three"], delta.Entries.Select(e => e.Raw));
        Assert.All(delta.Entries, e => Assert.Equal("2026-09-03/1115.txt", e.Bucket));
        Assert.Equal("2026-09-03/1115.txt:3", delta.Cursor.ToString());

        // Asked again with what it was handed: nothing, and the same place.
        var again = feed.After(delta.Cursor);
        Assert.Empty(again.Entries);
        Assert.Equal(delta.Cursor, again.Cursor);
    }

    /// <summary>
    /// The quarter hour turns and the follower does not notice.
    /// </summary>
    /// <remarks>
    /// This is the property the cursor exists for. A client that was following
    /// <c>1115</c> asks for what is after its place in it and is handed the rest
    /// of <c>1115</c>, then the whole of <c>1130</c>, with a cursor into
    /// <c>1130</c> — one ask, no gap, nothing twice.
    /// </remarks>
    [Fact]
    public async Task CarriesAFollowerAcrossTheBucketRollover()
    {
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one", "[11:29] chef: two");
        await WriteAsync("2026-09-03/1130.txt", "[11:30] feat-login: three", "    and more");

        using var feed = new RoomFeed(_repo);

        var delta = feed.After(new RoomCursor("2026-09-03/1115.txt", 1));

        Assert.Equal(
            [
                ("2026-09-03/1115.txt", "[11:29] chef: two"),
                ("2026-09-03/1130.txt", "[11:30] feat-login: three"),
                ("2026-09-03/1130.txt", "    and more"),
            ],
            delta.Entries.Select(e => (e.Bucket, e.Raw)));

        Assert.Equal("2026-09-03/1130.txt:2", delta.Cursor.ToString());
    }

    /// <summary>The day turns too, and yesterday's last bucket sorts before today's first.</summary>
    [Fact]
    public async Task CarriesAFollowerAcrossMidnight()
    {
        await WriteAsync("2026-09-03/2345.txt", "[23:59] chef: late");
        await WriteAsync("2026-09-04/0000.txt", "[00:00] chef: early");

        using var feed = new RoomFeed(_repo);

        var delta = feed.After(new RoomCursor("2026-09-03/2345.txt", 1));

        Assert.Equal(["[00:00] chef: early"], delta.Entries.Select(e => e.Raw));
        Assert.Equal("2026-09-04/0000.txt:1", delta.Cursor.ToString());
    }

    /// <summary>From the start of nothing, everything — and from an empty room, nothing and the start.</summary>
    [Fact]
    public async Task StartsFromTheBeginningWhenAskedTo()
    {
        using var feed = new RoomFeed(_repo);

        var empty = feed.After(RoomCursor.Start);
        Assert.Empty(empty.Entries);
        Assert.True(empty.Cursor.IsStart);
        Assert.True(feed.End().IsStart);

        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one");

        var all = feed.After(RoomCursor.Start);
        Assert.Single(all.Entries);
        Assert.Equal("2026-09-03/1115.txt:1", all.Cursor.ToString());
        Assert.Equal(all.Cursor, feed.End());
    }

    /// <summary>
    /// Lines are counted the way <c>wc -l</c> counts them.
    /// </summary>
    /// <remarks>
    /// The guest's shell and this class have to agree about a file's length, or
    /// the count-based first sync appends a line twice or skips one. So: a line
    /// somebody is still writing is not a line yet, a blank line is a line, and
    /// a carriage return is not a terminator.
    /// </remarks>
    [Fact]
    public async Task CountsTerminatedLinesOnly()
    {
        var path = Bucket("2026-09-03/1115.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "[11:16] chef: one\r\n\n[11:17] chef: two\n[11:18] chef: half");

        Assert.Equal(["[11:16] chef: one", "", "[11:17] chef: two"], RoomFeed.Physical(path));
    }

    /// <summary>The lines between two cursors, for the append that answers with what landed meanwhile.</summary>
    [Fact]
    public async Task ReadsBetweenTwoCursorsAndNoFurther()
    {
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one", "[11:17] chef: two");
        await WriteAsync("2026-09-03/1130.txt", "[11:30] chef: three", "[11:31] chef: four", "[11:32] chef: five");

        using var feed = new RoomFeed(_repo);

        var between = feed.Between(new RoomCursor("2026-09-03/1115.txt", 1), new RoomCursor("2026-09-03/1130.txt", 2));

        Assert.Equal(["[11:17] chef: two", "[11:30] chef: three", "[11:31] chef: four"], between.Entries.Select(e => e.Raw));
        Assert.Equal("2026-09-03/1130.txt:2", between.Cursor.ToString());
    }

    /// <summary>
    /// An append answers with what landed meanwhile, minus what was appended.
    /// </summary>
    /// <remarks>
    /// The guest posts its lines and is following at the same time; if the
    /// answer included its own lines it would append them locally a second
    /// time, and if it skipped to the end it would miss what the chef said in
    /// between. Duplicates are counted, not set-compared: two identical lines
    /// from two sides are two lines.
    /// </remarks>
    [Fact]
    public async Task AnAppendAnswersWithTheGapButNotTheEcho()
    {
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one");

        using var feed = new RoomFeed(_repo);
        var was = feed.End();

        // The chef speaks after the guest last looked, and says the same thing
        // the guest is about to.
        await WriteAsync("2026-09-03/1115.txt", "[11:17] chef: meanwhile", "[11:18] chef: ack");

        var answer = await feed.AppendAsync(was,
        [
            new RoomEntry("2026-09-03/1115.txt", "[11:18] feat-login: mine"),
            new RoomEntry("2026-09-03/1115.txt", "[11:18] chef: ack"),
        ]);

        Assert.Equal(["[11:17] chef: meanwhile", "[11:18] chef: ack"], answer.Entries.Select(e => e.Raw));
        Assert.Equal("2026-09-03/1115.txt:5", answer.Cursor.ToString());

        Assert.Equal(
            ["[11:16] chef: one", "[11:17] chef: meanwhile", "[11:18] chef: ack", "[11:18] feat-login: mine", "[11:18] chef: ack"],
            RoomFeed.Physical(Bucket("2026-09-03/1115.txt")));
    }

    [Fact]
    public void MissingCountsRatherThanCollapses()
    {
        RoomEntry[] sent = [new("b", "    more")];
        RoomEntry[] all = [new("b", "[10:00] a: x"), new("b", "    more"), new("b", "[10:01] b: y"), new("b", "    more")];

        Assert.Equal(
            ["[10:00] a: x", "[10:01] b: y", "    more"],
            RoomFeed.Missing(sent, all).Select(e => e.Raw));
    }

    /// <summary>
    /// A waiter is woken by an append, not left to the timer.
    /// </summary>
    /// <remarks>
    /// The whole point of the feed over a poll. The wait is far longer than the
    /// timer so that a wake by the timer alone would still pass; what is
    /// asserted is that the answer carries the line, and that it arrives well
    /// inside the wait rather than at its end.
    /// </remarks>
    [Fact]
    public async Task WakesAWaiterWhenALineLands()
    {
        using var feed = new RoomFeed(_repo);
        var cursor = feed.End();

        var waiting = feed.WaitAsync(cursor, TimeSpan.FromSeconds(20));
        await Task.Delay(200);
        Assert.False(waiting.IsCompleted);

        var started = DateTime.UtcNow;
        await feed.AppendAsync("[11:16] chef: hello", new DateTime(2026, 9, 3, 11, 16, 0));

        var delta = await waiting.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(["[11:16] chef: hello"], delta.Entries.Select(e => e.Raw));
        Assert.Equal("2026-09-03/1115.txt:1", delta.Cursor.ToString());
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(5), "the waiter was woken by the timer, not the append");
    }

    /// <summary>A line written by somebody else — the CLI, an editor — wakes a waiter too, within the poll interval at worst.</summary>
    [Fact]
    public async Task WakesAWaiterForALineWrittenBehindItsBack()
    {
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: one");

        using var feed = new RoomFeed(_repo);
        var cursor = feed.End();

        var waiting = feed.WaitAsync(cursor, TimeSpan.FromSeconds(20));
        await Task.Delay(100);

        await WriteAsync("2026-09-03/1115.txt", "[11:17] hazel: two");

        var delta = await waiting.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(["[11:17] hazel: two"], delta.Entries.Select(e => e.Raw));
    }

    [Fact]
    public async Task AnsweredEmptyWhenTheWaitRunsOut()
    {
        using var feed = new RoomFeed(_repo);

        var delta = await feed.WaitAsync(RoomCursor.Start, TimeSpan.FromMilliseconds(300));

        Assert.Empty(delta.Entries);
        Assert.True(delta.Cursor.IsStart);
    }

    /// <summary>The recent room and its end come from one read, so a follower opened from that cursor misses nothing.</summary>
    [Fact]
    public async Task TheRecentRoomEndsWhereFollowingBegins()
    {
        await WriteAsync("2026-09-03/1045.txt", "[10:46] chef: old");
        await WriteAsync("2026-09-03/1100.txt", "[11:01] chef: a");
        await WriteAsync("2026-09-03/1115.txt", "[11:16] chef: b");

        using var feed = new RoomFeed(_repo);

        var recent = feed.Recent(2);

        Assert.Equal(["[11:01] chef: a", "[11:16] chef: b"], recent.Entries.Select(e => e.Raw));
        Assert.Equal("2026-09-03/1115.txt:1", recent.Cursor.ToString());
        Assert.Empty(feed.After(recent.Cursor).Entries);
    }
}

/// <summary>
/// The text form the instance's client speaks: a bucket, a tab, a line.
/// </summary>
public class RoomWireTests
{
    [Fact]
    public void RoundTripsEntriesThroughText()
    {
        RoomEntry[] entries =
        [
            new("2026-09-03/1115.txt", "[11:16] chef: it's $HOME; `rm -rf`\twith a tab"),
            new("2026-09-03/1115.txt", "    and a continuation"),
            new("2026-09-03/1130.txt", ""),
        ];

        var text = RoomWire.Format(entries);

        Assert.Equal(
            "2026-09-03/1115.txt\t[11:16] chef: it's $HOME; `rm -rf`\twith a tab\n" +
            "2026-09-03/1115.txt\t    and a continuation\n" +
            "2026-09-03/1130.txt\t\n",
            text);

        Assert.Equal(entries, RoomWire.Parse(text));
    }

    /// <summary>What comes back from a shell may end in CRLF; the frame does not care, and blank lines are skipped.</summary>
    [Fact]
    public void ParsesWhatAShellMightSend()
    {
        var entries = RoomWire.Parse("2026-09-03/1115.txt\t[11:16] chef: hi\r\n\n2026-09-03/1115.txt\t    more\r\n");

        Assert.Equal(["[11:16] chef: hi", "    more"], entries.Select(e => e.Raw));
    }

    [Theory]
    [InlineData("no tab here")]
    [InlineData("\t[11:16] chef: no bucket")]
    [InlineData("../../etc/passwd\tx")]
    [InlineData("2026-09-03/1117.txt\tnot a quarter hour")]
    [InlineData("2026-09-03/2515.txt\tnot an hour")]
    [InlineData("2026-09-03.txt\tthe flat form is read, never written")]
    [InlineData(".env\tthe server record is not a channel")]
    public void RefusesALineItWouldNotWrite(string text) =>
        Assert.Throws<FormatException>(() => RoomWire.Parse(text));
}
