using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

using Envmux.Config;

namespace Envmux.Agents;

/// <summary>One line of the room, taken apart.</summary>
/// <param name="At"><c>HH:MM</c>, as written.</param>
/// <param name="Room">The situation-room slug, when the line carries one. Null in the main room.</param>
/// <param name="Name">Who said it.</param>
/// <param name="IsEvent">A <c>* name …</c> presence line rather than talk.</param>
/// <param name="Text">What was said, continuation lines folded back in with newlines.</param>
/// <param name="Raw">The line exactly as it is on disk, continuation lines included.</param>
internal sealed record ChatLine(string At, string? Room, string Name, bool IsEvent, string Text, string Raw)
{
    /// <summary>Whether this line is addressed to somebody — <c>@nick</c> anywhere in it, or <c>@all</c>.</summary>
    public bool Mentions(string nick) =>
        Chatroom.MentionPattern.Matches(Text).Any(m =>
            m.Groups[1].Value.Equals(nick, StringComparison.Ordinal) ||
            m.Groups[1].Value.Equals("all", StringComparison.Ordinal));
}

/// <summary>
/// The cross-agent chatroom, as the <c>prompt-context</c> plugin defines it.
/// </summary>
/// <remarks>
/// <para>
/// This is somebody else's protocol, implemented rather than reinvented. A
/// project's agents — Claude, Codex, whatever else is working in the checkout —
/// coordinate through plain-text, append-only files at
/// <c>.context/chatroom/YYYY-MM-DD/HHMM.txt</c>: a directory per local day, a
/// file per quarter hour, named for the bucket it opens. No header, no
/// ceremony, four line shapes. It is what the skills in that plugin teach every
/// agent to read and write with <c>date</c> and <c>printf</c>, and anything
/// envmux writes has to be indistinguishable from that.
/// </para>
/// <para>
/// envmux's interest is narrow. A remote agent runs in an instance on the
/// IncusOS host, and <c>.context/</c> is git-ignored, so it is not in the bundle
/// the repository travels as. This class is the format; <see cref="RoomFeed"/>
/// serves it over the API and <see cref="RoomClient"/> is what carries it across
/// from the instance's side, and the <c>agent</c> command and the portal are
/// what let a person, or the agent sitting with them, take part from this side.
/// </para>
/// <para>
/// Times are <em>local</em>, per the convention, which is a real hazard once a
/// second machine is involved: an instance's clock is UTC, and an agent in it
/// computing the bucket with <c>date</c> would file its lines twelve hours away
/// from where anyone on the workstation looks. <see cref="PosixTimeZone"/> is
/// the answer — the session carries the workstation's offset in <c>TZ</c>.
/// </para>
/// </remarks>
internal static partial class Chatroom
{
    /// <summary>The git-ignored workspace the channels live in, relative to the repository root.</summary>
    public const string ContextDirectory = ".context";

    /// <summary>The room, relative to the repository root.</summary>
    public const string RoomDirectory = ".context/chatroom";

    /// <summary>The one file in the room that is not a channel: the chat server's discovery record.</summary>
    public const string ServerRecord = ".env";

    /// <summary>The nick the workstation side speaks as when nobody names one.</summary>
    /// <remarks>
    /// A role rather than a person, the way the plugin's <c>captain</c> is: the
    /// headed session everything is delegated from. An agent with a name of its
    /// own should pass it; a person typing in the portal is welcome to theirs.
    /// </remarks>
    public const string DefaultNick = "chef";

    /// <summary>How many buckets "the recent room" is, per the convention: the last hour.</summary>
    public const int RecentBuckets = 4;

    /// <summary>What a nick — or a situation-room slug — may look like.</summary>
    [GeneratedRegex("^[a-z][a-z0-9_-]{0,23}$")]
    private static partial Regex NickPattern();

    /// <summary>
    /// The four line shapes, in one expression.
    /// </summary>
    /// <remarks>
    /// <c>[HH:MM]</c>, an optional <c>{slug}</c> tag, then either <c>* name
    /// event</c> or <c>name: text</c>. The tag sits between the timestamp and the
    /// name — that placement is the only on-disk difference between a situation
    /// room and the main room, and a reader written before situation rooms
    /// existed still reads the main room correctly, which is a property worth
    /// keeping on this side too.
    /// </remarks>
    [GeneratedRegex(@"^\[(\d\d:\d\d)\] (?:\{([a-z][a-z0-9_-]{0,23})\} )?(?:\* ([a-z][a-z0-9_-]*)(?: (.*))?|([a-z][a-z0-9_-]*): ?(.*))$")]
    private static partial Regex LinePattern();

    [GeneratedRegex(@"@([a-z][a-z0-9_-]*)")]
    private static partial Regex Mention();

    internal static Regex MentionPattern => Mention();

    /// <summary>Where the room is, for a repository.</summary>
    public static string Root(string repository) =>
        Path.Combine(repository, ContextDirectory, "chatroom");

    /// <summary>
    /// The day and the bucket a moment falls in.
    /// </summary>
    /// <remarks>
    /// The quarter hour the message starts in, rounded down: <c>0000</c>,
    /// <c>0015</c>, <c>0030</c>, <c>0045</c>, <c>0100</c>. Recomputed on every
    /// write and never cached, because it changes underneath a caller four times
    /// an hour and a line filed into a bucket that has passed is a line nobody
    /// reads.
    /// </remarks>
    public static (string Day, string Bucket) BucketOf(DateTime local) =>
        (local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
         $"{local.Hour.ToString("00", CultureInfo.InvariantCulture)}{(local.Minute / 15 * 15).ToString("00", CultureInfo.InvariantCulture)}");

    /// <summary>The bucket file for a moment, relative to the room: <c>2026-09-03/1115.txt</c>.</summary>
    public static string RelativeBucket(DateTime local)
    {
        var (day, bucket) = BucketOf(local);
        return $"{day}/{bucket}.txt";
    }

    /// <summary>The bucket file for a moment, as a path on this machine.</summary>
    public static string BucketPath(string repository, DateTime local)
    {
        var (day, bucket) = BucketOf(local);
        return Path.Combine(Root(repository), day, $"{bucket}.txt");
    }

    /// <summary>The bucket files a relay should look at now: this quarter hour and the one before.</summary>
    /// <remarks>
    /// Two, not one: a line written at 11:59:58 lands in <c>1145</c> and is not
    /// carried until the next poll, which is in <c>1200</c>. The previous bucket
    /// covers that; anything older is closed and, by the convention, gains no
    /// lines.
    /// </remarks>
    public static IReadOnlyList<string> LiveBuckets(DateTime local) =>
        [RelativeBucket(local.AddMinutes(-15)), RelativeBucket(local)];

    /// <summary>Whether a string is a nick the room accepts.</summary>
    public static bool IsNick(string candidate) => NickPattern().IsMatch(candidate);

    /// <summary>
    /// A nick for a session, which is what a remote agent is called in the room.
    /// </summary>
    /// <remarks>
    /// A session name is already a slug — lowercase, digits, hyphens — so it
    /// nearly is one. The two ways it can fail are being longer than 24
    /// characters and starting with a digit, and both are fixed rather than
    /// refused: the name is the branch and the instance too, and refusing to
    /// speak because of it would be the wrong thing to be strict about.
    /// </remarks>
    public static string Nick(string session)
    {
        var slug = Slug.From(session);

        if (!char.IsAsciiLetterLower(slug[0]))
        {
            slug = "a-" + slug;
        }

        if (slug.Length > 24)
        {
            slug = slug[..24].TrimEnd('-');
        }

        return slug;
    }

    /// <summary>
    /// The room a project's agents share, and no other project's.
    /// </summary>
    /// <remarks>
    /// The room is a directory in the repository, so two repositories cannot
    /// share one by construction. The name matters where a room is <em>named</em>
    /// rather than found — a join line, a situation-room address, an instance's
    /// environment — and there it is the project name from <c>.envmux.json</c>,
    /// the same label the instance and the hostname carry, so a line can always
    /// be traced to the project it came from.
    /// </remarks>
    public static string Room(string project) => $"#{Slug.From(project)}";

    /// <summary>An ordinary line: <c>[HH:MM] name: text</c>.</summary>
    /// <remarks>
    /// A newline in the text becomes a continuation line, indented four spaces,
    /// which is what the grammar allows for a long thought. Carriage returns are
    /// dropped: the files are <c>\n</c>-terminated and a stray <c>\r</c> would
    /// be read back as part of the text.
    /// </remarks>
    public static string Say(DateTime at, string nick, string text) =>
        $"[{Stamp(at)}] {nick}: {Fold(text)}";

    /// <summary>An addressed line: <c>[HH:MM] name: @other text</c>.</summary>
    public static string SayTo(DateTime at, string nick, string to, string text) =>
        Say(at, nick, $"@{to} {text}");

    /// <summary>A presence line: <c>[HH:MM] * name event</c>.</summary>
    public static string Event(DateTime at, string nick, string what) =>
        $"[{Stamp(at)}] * {nick} {Fold(what)}";

    private static string Stamp(DateTime at) => at.ToString("HH:mm", CultureInfo.InvariantCulture);

    private static string Fold(string text) =>
        string.Join("\n    ", text.ReplaceLineEndings("\n").Split('\n').Select(l => l.TrimEnd()));

    /// <summary>
    /// Read one line — the first physical line of a message — into its parts.
    /// </summary>
    /// <returns>Null for a continuation line, a blank, or anything that is not one of the four shapes.</returns>
    public static ChatLine? Parse(string line)
    {
        var text = line.TrimEnd('\r', '\n');

        if (LinePattern().Match(text) is not { Success: true } m)
        {
            return null;
        }

        var room = m.Groups[2].Success ? m.Groups[2].Value : null;

        return m.Groups[3].Success
            ? new ChatLine(m.Groups[1].Value, room, m.Groups[3].Value, true, m.Groups[4].Value, text)
            : new ChatLine(m.Groups[1].Value, room, m.Groups[5].Value, false, m.Groups[6].Value, text);
    }

    /// <summary>
    /// Read a bucket's worth of lines, folding continuation lines into the message they continue.
    /// </summary>
    /// <remarks>
    /// Anything that is neither a message nor a continuation of one is dropped
    /// rather than thrown on. The files are written by hand, by several agents,
    /// through shells on two operating systems; a line that does not parse is a
    /// line to skip, not a reason to stop reading the room.
    /// </remarks>
    public static IReadOnlyList<ChatLine> ParseAll(IEnumerable<string> lines)
    {
        var result = new List<ChatLine>();

        foreach (var raw in lines)
        {
            var line = raw.TrimEnd('\r', '\n');

            if (line.Length == 0)
            {
                continue;
            }

            if (Parse(line) is { } parsed)
            {
                result.Add(parsed);
            }
            else if (line.StartsWith("    ", StringComparison.Ordinal) && result.Count > 0)
            {
                var last = result[^1];
                result[^1] = last with
                {
                    Text = last.Text + "\n" + line[4..],
                    Raw = last.Raw + "\n" + line,
                };
            }
        }

        return result;
    }

    /// <summary>
    /// Append one message to the current bucket, creating the day as needed.
    /// </summary>
    /// <remarks>
    /// Opened for append and shared for reading and writing, because another
    /// agent — or the relay — may be appending at the same moment, and the room
    /// tolerates the odd interleaved line by design. Never a whole-file write:
    /// that silently destroys everyone else's messages, and is the one thing the
    /// convention forbids in capitals.
    /// </remarks>
    public static async Task AppendAsync(string repository, string line, DateTime now, CancellationToken ct = default)
    {
        var path = BucketPath(repository, now);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        await AppendLinesAsync(path, [line], ct).ConfigureAwait(false);
    }

    /// <summary>Append lines that already carry their timestamps, to a named bucket file.</summary>
    public static async Task AppendLinesAsync(string path, IReadOnlyList<string> lines, CancellationToken ct = default)
    {
        if (lines.Count == 0)
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var bytes = Encoding.UTF8.GetBytes(string.Concat(lines.Select(l => l.ReplaceLineEndings("\n") + "\n")));

        await using var stream = new FileStream(
            path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite, 4096, useAsync: true);

        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
    }

    /// <summary>The physical lines of a bucket file, or none when there is no such file.</summary>
    public static IReadOnlyList<string> Lines(string path) =>
        File.Exists(path)
            ? [.. File.ReadAllText(path, Encoding.UTF8).ReplaceLineEndings("\n").Split('\n').Where(l => l.Length > 0)]
            : [];

    /// <summary>The physical lines in a bucket's bytes, as the files API hands them back.</summary>
    public static IReadOnlyList<string> Lines(byte[]? bytes) =>
        bytes is null
            ? []
            : [.. Encoding.UTF8.GetString(bytes).ReplaceLineEndings("\n").Split('\n').Where(l => l.Length > 0)];

    /// <summary>
    /// Every bucket file in the room, oldest first.
    /// </summary>
    /// <remarks>
    /// Sorted by relative path, which is chronological by construction — the
    /// convention's own readback is <c>find … | sort | tail -4</c>. Older repos
    /// hold flat <c>YYYY-MM-DD.txt</c> files from before the chunking; they sort
    /// among the days and are read the same way. <c>.env</c> is not a channel and
    /// is left out.
    /// </remarks>
    public static IReadOnlyList<string> Buckets(string repository)
    {
        var root = Root(repository);

        if (!Directory.Exists(root))
        {
            return [];
        }

        return
        [
            .. Directory.EnumerateFiles(root, "*.txt", SearchOption.AllDirectories)
                .Select(p => (Path: p, Key: Path.GetRelativePath(root, p).Replace('\\', '/')))
                .OrderBy(e => e.Key, StringComparer.Ordinal)
                .Select(e => e.Path),
        ];
    }

    /// <summary>
    /// The recent room: the last few buckets, parsed.
    /// </summary>
    /// <remarks>
    /// Four buckets is the last hour, or — if the room has been quiet — the last
    /// hour anyone spoke, which is the same thing for a reader's purposes. Not the
    /// whole day: the convention is explicit that reading the day buys history
    /// nobody acts on at a real cost in context.
    /// </remarks>
    public static IReadOnlyList<ChatLine> ReadRecent(string repository, int buckets = RecentBuckets) =>
        ParseAll(Buckets(repository).TakeLast(Math.Max(1, buckets)).SelectMany(Lines));

    /// <summary>The names that have joined the room, for choosing one nobody has.</summary>
    public static IReadOnlyList<string> Names(string repository) =>
    [
        .. Buckets(repository)
            .SelectMany(Lines)
            .Select(Parse)
            .Where(l => l is { IsEvent: true })
            .Select(l => l!.Name)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal),
    ];

    /// <summary>
    /// The workstation's clock, as a <c>TZ</c> an instance can be given.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The convention stamps every line with local time and files it in a local
    /// quarter hour, and the instance's clock is UTC. Without this an agent in
    /// New Zealand's session writes <c>[23:05]</c> into <c>2300.txt</c> in
    /// yesterday's directory while the workstation is at 11:05 tomorrow, and the
    /// two sides of one conversation are twelve hours and a day apart on disk.
    /// </para>
    /// <para>
    /// A POSIX offset rather than a zone name, because this binary runs with
    /// invariant globalization and cannot map a Windows zone id to an IANA one
    /// reliably — and because an instance is not guaranteed to have tzdata. The
    /// sign is POSIX's, which is the number added to local time to reach UTC:
    /// UTC+12 is <c>ENVMUX-12</c>. It does not follow daylight-saving changes
    /// during a session, which is a known cost of not shipping a zone.
    /// </para>
    /// </remarks>
    public static string PosixTimeZone(TimeSpan offset)
    {
        if (offset == TimeSpan.Zero)
        {
            return "ENVMUX0";
        }

        // Inverted: a positive offset from UTC is written with a minus.
        var sign = offset < TimeSpan.Zero ? '+' : '-';
        var magnitude = offset.Duration();

        return magnitude.Minutes == 0
            ? $"ENVMUX{sign}{magnitude.Hours.ToString(CultureInfo.InvariantCulture)}"
            : $"ENVMUX{sign}{magnitude.Hours.ToString(CultureInfo.InvariantCulture)}:{magnitude.Minutes.ToString("00", CultureInfo.InvariantCulture)}";
    }

    /// <summary>The environment variable the offset travels in.</summary>
    public const string TimeZoneVariable = "TZ";
}
