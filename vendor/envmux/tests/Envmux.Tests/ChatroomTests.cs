using System.Text;

using Envmux.Agents;

namespace Envmux.Tests;

/// <summary>
/// The room's format, as the <c>prompt-context</c> plugin defines it.
/// </summary>
/// <remarks>
/// Pure: no host, no instance. What is under test is that a line envmux writes
/// is one the plugin's own <c>date</c>-and-<c>printf</c> recipes would have
/// written, and that a line those recipes wrote is one envmux reads back the
/// same way — because a room where the two sides disagree about a bucket or a
/// timestamp is two rooms.
/// </remarks>
public class ChatroomTests : IDisposable
{
    private readonly string _repo = Directory.CreateTempSubdirectory("envmux-room-").FullName;

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

    [Theory]
    [InlineData(11, 46, "1145")]
    [InlineData(11, 44, "1130")]
    [InlineData(0, 7, "0000")]
    [InlineData(23, 59, "2345")]
    [InlineData(9, 0, "0900")]
    [InlineData(9, 15, "0915")]
    public void FilesAMessageInTheQuarterHourItStartsIn(int hour, int minute, string bucket)
    {
        var (day, actual) = Chatroom.BucketOf(new DateTime(2026, 9, 3, hour, minute, 30));

        Assert.Equal("2026-09-03", day);
        Assert.Equal(bucket, actual);
        Assert.Equal($"2026-09-03/{bucket}.txt", Chatroom.RelativeBucket(new DateTime(2026, 9, 3, hour, minute, 30)));
    }

    /// <summary>
    /// The relay looks at this bucket and the one before it, and the one before
    /// midnight is in yesterday's directory.
    /// </summary>
    [Fact]
    public void TheLiveBucketsCrossMidnight()
    {
        var live = Chatroom.LiveBuckets(new DateTime(2026, 9, 4, 0, 5, 0));

        Assert.Equal(["2026-09-03/2345.txt", "2026-09-04/0000.txt"], live);
    }

    [Fact]
    public void WritesTheFourShapesTheConventionAllows()
    {
        var at = new DateTime(2026, 9, 3, 9, 41, 12);

        Assert.Equal("[09:41] hazel: taking plugins/prompt-context/", Chatroom.Say(at, "hazel", "taking plugins/prompt-context/"));
        Assert.Equal("[09:41] hazel: @rimu does .context/ get excluded?", Chatroom.SayTo(at, "hazel", "rimu", "does .context/ get excluded?"));
        Assert.Equal("[09:41] * hazel joined (Claude / claude-opus-5)", Chatroom.Event(at, "hazel", "joined (Claude / claude-opus-5)"));
    }

    /// <summary>A long thought indents its continuation lines four spaces — and never carries a CR.</summary>
    [Fact]
    public void FoldsANewlineIntoAContinuationLine()
    {
        var line = Chatroom.Say(new DateTime(2026, 9, 3, 10, 3, 0), "rimu", "first\r\nsecond\nthird");

        Assert.Equal("[10:03] rimu: first\n    second\n    third", line);
        Assert.DoesNotContain('\r', line);
    }

    [Fact]
    public void ReadsEachShapeBack()
    {
        var talk = Chatroom.Parse("[10:03] rimu: @hazel does .context/ get excluded?");
        Assert.NotNull(talk);
        Assert.Equal(("10:03", "rimu", false), (talk.At, talk.Name, talk.IsEvent));
        Assert.Equal("@hazel does .context/ get excluded?", talk.Text);
        Assert.Null(talk.Room);
        Assert.True(talk.Mentions("hazel"));
        Assert.False(talk.Mentions("hazelnut"));
        Assert.False(talk.Mentions("rimu"));

        var joined = Chatroom.Parse("[09:40] * hazel joined (Claude / claude-opus-5) — working on the context plugin");
        Assert.NotNull(joined);
        Assert.True(joined.IsEvent);
        Assert.Equal("hazel", joined.Name);
        Assert.StartsWith("joined", joined.Text, StringComparison.Ordinal);

        var afk = Chatroom.Parse("[11:02] * hazel afk");
        Assert.NotNull(afk);
        Assert.Equal("afk", afk.Text);

        var situation = Chatroom.Parse("[10:45] {schema-cutover} hazel: rimu, the backfill is only half done");
        Assert.NotNull(situation);
        Assert.Equal("schema-cutover", situation.Room);
        Assert.Equal("hazel", situation.Name);

        var opened = Chatroom.Parse("[10:44] * hazel opened #myrepo/schema-cutover — old column still live in prod");
        Assert.NotNull(opened);
        Assert.Null(opened.Room);
    }

    [Fact]
    public void MentionsEveryoneWithAll()
    {
        var line = Chatroom.Parse("[10:28] captain: @all RESTARTING NOW on batch 3")!;

        Assert.True(line.Mentions("q7"));
        Assert.True(line.Mentions("hazel"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("    a continuation on its own")]
    [InlineData("hello")]
    [InlineData("[9:41] hazel: no leading zero")]
    [InlineData("[09:41] Hazel: capitals are not a nick")]
    [InlineData("CHAT_URL=http://127.0.0.1:7331")]
    public void DropsWhatIsNotALine(string line)
    {
        Assert.Null(Chatroom.Parse(line));
    }

    [Fact]
    public void FoldsContinuationLinesBackIntoTheirMessage()
    {
        var lines = Chatroom.ParseAll(
        [
            "[10:11] captain: @q7 BELAY — @v1 owns the clock until it posts done. Verify against a throwaway",
            "    Postgres instead, or wait ~5 min",
            "[10:12] q7: ack, throwaway it is",
            "",
            "garbage that is not a line",
        ]);

        Assert.Equal(2, lines.Count);
        Assert.Equal("@q7 BELAY — @v1 owns the clock until it posts done. Verify against a throwaway\nPostgres instead, or wait ~5 min", lines[0].Text);
        Assert.Contains("\n    Postgres", lines[0].Raw, StringComparison.Ordinal);
        Assert.Equal("q7", lines[1].Name);
    }

    [Theory]
    [InlineData("feat-login", "feat-login")]
    [InlineData("Feat/Login", "feat-login")]
    [InlineData("123abc", "a-123abc")]
    [InlineData("a-very-long-session-name-that-goes-on", "a-very-long-session-name")]
    public void MakesANickOutOfASessionName(string session, string nick)
    {
        Assert.Equal(nick, Chatroom.Nick(session));
        Assert.True(Chatroom.IsNick(nick));
    }

    [Theory]
    [InlineData("hazel", true)]
    [InlineData("first-mate", true)]
    [InlineData("q7", true)]
    [InlineData("Hazel", false)]
    [InlineData("7up", false)]
    [InlineData("", false)]
    [InlineData("twenty-five-characters-xx", false)]
    public void KnowsWhatANickIs(string candidate, bool ok)
    {
        Assert.Equal(ok, Chatroom.IsNick(candidate));
    }

    /// <summary>The room is named for the project, so two projects' agents never share one.</summary>
    [Fact]
    public void BindsTheRoomToTheProject()
    {
        Assert.Equal("#myproj", Chatroom.Room("myproj"));
        Assert.Equal("#my-proj", Chatroom.Room("My Proj"));
        Assert.NotEqual(Chatroom.Room("alpha"), Chatroom.Room("beta"));
    }

    /// <summary>POSIX's sign: the number added to local time to reach UTC.</summary>
    [Theory]
    [InlineData(12, 0, "ENVMUX-12")]
    [InlineData(-5, 0, "ENVMUX+5")]
    [InlineData(12, 45, "ENVMUX-12:45")]
    [InlineData(5, 30, "ENVMUX-5:30")]
    [InlineData(-3, -30, "ENVMUX+3:30")]
    [InlineData(0, 0, "ENVMUX0")]
    public void CarriesTheWorkstationsClockAsAPosixOffset(int hours, int minutes, string tz)
    {
        Assert.Equal(tz, Chatroom.PosixTimeZone(new TimeSpan(hours, minutes, 0)));
    }

    [Fact]
    public async Task AppendsToTheCurrentBucketAndOnlyAppends()
    {
        var at = new DateTime(2026, 9, 3, 11, 46, 0);

        await Chatroom.AppendAsync(_repo, Chatroom.Say(at, "chef", "first"), at);
        await Chatroom.AppendAsync(_repo, Chatroom.Say(at.AddMinutes(1), "chef", "second"), at.AddMinutes(1));

        var path = Path.Combine(_repo, ".context", "chatroom", "2026-09-03", "1145.txt");
        Assert.True(File.Exists(path));

        var bytes = await File.ReadAllBytesAsync(path);
        var text = Encoding.UTF8.GetString(bytes);

        Assert.Equal("[11:46] chef: first\n[11:47] chef: second\n", text);

        // No BOM and no CRLF: the other readers are `tail` and `grep` in a shell.
        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        Assert.DoesNotContain('\r', text);
    }

    [Fact]
    public async Task ReadsTheLastFourBucketsAndNoMore()
    {
        var root = Path.Combine(_repo, ".context", "chatroom", "2026-09-03");
        Directory.CreateDirectory(root);

        foreach (var bucket in new[] { "0900", "0915", "0930", "0945", "1000", "1015" })
        {
            await File.WriteAllTextAsync(Path.Combine(root, $"{bucket}.txt"), $"[{bucket[..2]}:{bucket[2..]}] hazel: in {bucket}\n");
        }

        // Not a channel, and not read as one.
        await File.WriteAllTextAsync(Path.Combine(_repo, ".context", "chatroom", ".env"), "CHAT_URL=http://127.0.0.1:7331\n");

        var recent = Chatroom.ReadRecent(_repo);

        Assert.Equal(["in 0930", "in 0945", "in 1000", "in 1015"], recent.Select(l => l.Text));
        Assert.Equal(6, Chatroom.ReadRecent(_repo, 10).Count);

        // Talk is not presence: nobody has joined this room.
        Assert.Empty(Chatroom.Names(_repo));
    }

    [Fact]
    public void ReadsARoomThatDoesNotExistAsEmpty()
    {
        Assert.Empty(Chatroom.ReadRecent(_repo));
        Assert.Empty(Chatroom.Buckets(_repo));
        Assert.Empty(Chatroom.Names(_repo));
    }

    [Fact]
    public async Task ListsWhoHasJoined()
    {
        var at = new DateTime(2026, 9, 3, 9, 40, 0);
        await Chatroom.AppendAsync(_repo, Chatroom.Event(at, "hazel", "joined (Claude / x)"), at);
        await Chatroom.AppendAsync(_repo, Chatroom.Event(at, "rimu", "joined (Codex / y)"), at);
        await Chatroom.AppendAsync(_repo, Chatroom.Say(at, "hazel", "hello"), at);

        Assert.Equal(["hazel", "rimu"], Chatroom.Names(_repo));
    }

    /// <summary>A bucket written by a PowerShell recipe arrives with CRLF; it reads the same.</summary>
    [Fact]
    public void ToleratesCarriageReturnsFromTheOtherPlatform()
    {
        var lines = Chatroom.Lines(Encoding.UTF8.GetBytes("[09:41] hazel: one\r\n[09:42] hazel: two\r\n"));

        Assert.Equal(["[09:41] hazel: one", "[09:42] hazel: two"], lines);
    }
}
