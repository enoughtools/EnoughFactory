using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Envmux.Agents;

/// <summary>
/// A position in the room: a bucket, and how many of its physical lines have been read.
/// </summary>
/// <remarks>
/// <para>
/// The room is a sequence of files that only ever grow, sorted by relative
/// path, which is chronological by construction. So a reader's place in it is
/// two things — which file it was reading and how far down it got — and
/// everything after that place is the rest of that file plus every file that
/// sorts later. That is what makes the quarter-hour rollover a non-event: a
/// client that was following <c>1115.txt</c> at line 12 asks for what is after
/// <c>1115.txt:12</c> and is handed lines 13 onward of that bucket and then the
/// whole of <c>1130.txt</c>, with a cursor into <c>1130.txt</c> to ask with next
/// time. Nothing has to notice that the clock moved.
/// </para>
/// <para>
/// Lines are counted the way <c>wc -l</c> counts them — terminated lines only —
/// so the guest's shell and this class agree about a file's length, and a line
/// somebody is still writing is not handed out half-finished.
/// </para>
/// <para>
/// Written <c>2026-09-03/1115.txt:12</c>, which is what travels in a query and
/// a header. The empty string is the start of nothing: a cursor that has read
/// no bucket at all, which is where a client that wants only what happens next
/// begins, once <see cref="RoomFeed.Recent"/> has told it where "next" is.
/// </para>
/// </remarks>
internal readonly partial record struct RoomCursor(string Bucket, int Count)
{
    /// <summary>Before any bucket: nothing read.</summary>
    public static readonly RoomCursor Start = new("", 0);

    public bool IsStart => Bucket.Length == 0;

    /// <summary>The relative path of a bucket as it may appear in a cursor: segments of ordinary characters, no <c>..</c>.</summary>
    [GeneratedRegex(@"^(?!\.\.?(?:/|$))[A-Za-z0-9_.-]+(?:/(?!\.\.?(?:/|$))[A-Za-z0-9_.-]+)*$")]
    private static partial Regex BucketPattern();

    /// <summary>Whether a string names a bucket the way a cursor may.</summary>
    public static bool IsBucket(string bucket) => bucket.Length > 0 && BucketPattern().IsMatch(bucket);

    public override string ToString() =>
        IsStart ? "" : $"{Bucket}:{Count.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>Read a cursor back from the form <see cref="ToString"/> produces. Empty and null are <see cref="Start"/>.</summary>
    public static bool TryParse(string? text, out RoomCursor cursor)
    {
        cursor = Start;

        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        var colon = text.LastIndexOf(':');

        if (colon <= 0 ||
            !int.TryParse(text.AsSpan(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var count))
        {
            return false;
        }

        var bucket = text[..colon];

        if (!IsBucket(bucket))
        {
            return false;
        }

        cursor = new RoomCursor(bucket, count);
        return true;
    }

    /// <summary>Whether this cursor is at or beyond <paramref name="other"/>.</summary>
    public bool IsAtOrAfter(RoomCursor other)
    {
        var order = string.CompareOrdinal(Bucket, other.Bucket);
        return order > 0 || (order == 0 && Count >= other.Count);
    }
}

/// <summary>One physical line of the room, and the bucket it is in.</summary>
/// <param name="Bucket">The bucket's path relative to the room: <c>2026-09-03/1115.txt</c>.</param>
/// <param name="Raw">The line as it is on disk, without its terminator. A continuation line starts with four spaces.</param>
internal sealed record RoomEntry(string Bucket, string Raw)
{
    /// <summary>The line taken apart, or null for a continuation line or anything that is not one of the four shapes.</summary>
    public ChatLine? Line => Chatroom.Parse(Raw);
}

/// <summary>What a reader is handed: the lines after where it was, and where it is now.</summary>
internal sealed record RoomDelta(IReadOnlyList<RoomEntry> Entries, RoomCursor Cursor)
{
    public static readonly RoomDelta Empty = new([], RoomCursor.Start);
}

/// <summary>
/// The room on this machine, watched, so a reader can wait for the next line rather than ask for it.
/// </summary>
/// <remarks>
/// <para>
/// One per envmux process, behind both the portal's page and the API the
/// instance calls. It owns no state about the room beyond a directory to look
/// in: every read goes to the files, because the files are written by more
/// than this process — the CLI, an editor, another agent's own session — and a
/// cache would be a second opinion about what the room says.
/// </para>
/// <para>
/// What it adds is <em>waiting</em>. A <see cref="FileSystemWatcher"/> on the
/// room directory wakes every waiter when anything in it changes, and a
/// one-second timer wakes them regardless, because watchers miss things — a
/// file appended over a network share, a directory created after the watcher
/// was, a platform that coalesces events — and a poll that is one second late
/// is the floor rather than the ceiling. A waiter re-reads its own tail on each
/// wake and answers only when there is something to say, so the timer costs a
/// couple of small reads per waiter per second and nothing else.
/// </para>
/// <para>
/// The watcher is attached lazily, once the room directory exists. Making the
/// directory here would be wrong: <c>.context/</c> is a convention a
/// repository adopts, and the feed exists for repositories that have not as
/// much as for ones that have.
/// </para>
/// </remarks>
internal sealed class RoomFeed : IDisposable
{
    /// <summary>How often waiters are woken whether or not the watcher said anything.</summary>
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    /// <summary>The longest a single wait may be asked to last.</summary>
    /// <remarks>
    /// Comfortably inside any client's own timeout: a client that asks the
    /// server to block for exactly as long as it will wait is a race the slow
    /// side loses about half the time, and the way it loses is an empty answer
    /// that looks like a dead room.
    /// </remarks>
    public static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(30);

    private readonly string _root;
    private readonly Lock _gate = new();
    private readonly SemaphoreSlim _writes = new(1, 1);
    private readonly Timer _timer;

    private TaskCompletionSource _changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private FileSystemWatcher? _watcher;
    private bool _disposed;

    /// <param name="repository">The repository root; the room is <c>.context/chatroom/</c> under it.</param>
    public RoomFeed(string repository)
    {
        _root = Chatroom.Root(repository);
        Watch();

        // The fallback, and what attaches the watcher once the directory turns
        // up. Started after the fields it reads.
        _timer = new Timer(_ => Tick(), null, PollInterval, PollInterval);
    }

    /// <summary>Where the room is on disk.</summary>
    public string Root => _root;

    /// <summary>Where the room ends right now: the last bucket, and how long it is.</summary>
    public RoomCursor End()
    {
        var buckets = Buckets();

        if (buckets.Count == 0)
        {
            return RoomCursor.Start;
        }

        var last = buckets[^1];
        return new RoomCursor(last.Key, Physical(last.Path).Count);
    }

    /// <summary>
    /// The recent room, whole: the last few buckets and the cursor at their end.
    /// </summary>
    /// <remarks>
    /// One read, so the lines and the cursor describe the same moment. Reading
    /// the lines and then asking where the end is would leave a line that landed
    /// in between belonging to neither.
    /// </remarks>
    public RoomDelta Recent(int buckets)
    {
        var all = Buckets();
        var wanted = all.TakeLast(Math.Max(1, buckets)).ToList();
        var entries = new List<RoomEntry>();
        var cursor = RoomCursor.Start;

        foreach (var (key, path) in wanted)
        {
            var lines = Physical(path);
            entries.AddRange(lines.Select(l => new RoomEntry(key, l)));
            cursor = new RoomCursor(key, lines.Count);
        }

        return new RoomDelta(entries, cursor);
    }

    /// <summary>Everything after a cursor, and the cursor to ask with next time.</summary>
    public RoomDelta After(RoomCursor cursor) => Read(cursor, null);

    /// <summary>The lines between two cursors, and the second as where that leaves a reader.</summary>
    public RoomDelta Between(RoomCursor from, RoomCursor to) => Read(from, to);

    /// <summary>
    /// Everything after a cursor — waiting, up to a limit, for there to be anything.
    /// </summary>
    /// <remarks>
    /// The long poll. It answers the moment a line lands, or with nothing when
    /// the wait runs out, and the caller asks again with the cursor it was
    /// given. A wait of zero is an ordinary read.
    /// </remarks>
    public async Task<RoomDelta> WaitAsync(RoomCursor cursor, TimeSpan wait, CancellationToken ct = default)
    {
        var bounded = wait < TimeSpan.Zero ? TimeSpan.Zero : wait > MaxWait ? MaxWait : wait;
        var deadline = Environment.TickCount64 + (long)bounded.TotalMilliseconds;

        while (true)
        {
            // Taken before the read, so a change that lands between the read
            // and the wait wakes the wait rather than being lost until the timer.
            var changed = Changed;
            var delta = After(cursor);

            if (delta.Entries.Count > 0)
            {
                return delta;
            }

            var remaining = deadline - Environment.TickCount64;

            if (remaining <= 0)
            {
                return delta;
            }

            try
            {
                await changed.WaitAsync(TimeSpan.FromMilliseconds(remaining), ct).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                return After(cursor);
            }
        }
    }

    /// <summary>
    /// Append lines that already carry their timestamps, and say what else landed meanwhile.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For the guest, which posts what it appended locally and is following the
    /// room at the same time. If its next read simply took everything after its
    /// cursor, its own lines would come straight back to it and be appended a
    /// second time. So the append answers with the lines between the caller's
    /// cursor and the new end <em>minus the ones it just sent</em>, and the new
    /// end as its cursor — everything anyone else said in the gap, nothing of its
    /// own, and no gap left behind.
    /// </para>
    /// <para>
    /// "Minus the ones it sent" is by count rather than by set, because the same
    /// physical line legitimately appears twice — two messages with the same
    /// continuation, a repeated <c>ack</c> at the same minute — and a set would
    /// swallow somebody else's line that happened to read the same.
    /// </para>
    /// <para>
    /// Appends through the API are serialised here, so two guests posting at
    /// once each get an answer that accounts for the other. Appends from outside
    /// the process — the CLI, an editor — are not, and do not need to be: a
    /// line that lands after the end was measured is after the cursor handed
    /// back, and arrives on the next read.
    /// </para>
    /// </remarks>
    public async Task<RoomDelta> AppendAsync(RoomCursor after, IReadOnlyList<RoomEntry> lines, CancellationToken ct = default)
    {
        await _writes.WaitAsync(ct).ConfigureAwait(false);

        try
        {
            foreach (var group in lines.GroupBy(l => l.Bucket, StringComparer.Ordinal))
            {
                var path = Path.Combine(_root, group.Key.Replace('/', Path.DirectorySeparatorChar));
                await Chatroom.AppendLinesAsync(path, [.. group.Select(l => l.Raw)], ct).ConfigureAwait(false);
            }

            var end = End();
            var between = Between(after, end);

            Signal();

            return new RoomDelta(Missing(lines, between.Entries), end);
        }
        finally
        {
            _writes.Release();
        }
    }

    /// <summary>Append one line to the bucket a moment falls in.</summary>
    public Task<RoomDelta> AppendAsync(string line, DateTime now, CancellationToken ct = default) =>
        AppendAsync(RoomCursor.Start, [new RoomEntry(Chatroom.RelativeBucket(now), line)], ct);

    /// <summary>
    /// The lines in <paramref name="all"/> that are not accounted for by <paramref name="sent"/>, in order.
    /// </summary>
    internal static IReadOnlyList<RoomEntry> Missing(IReadOnlyList<RoomEntry> sent, IReadOnlyList<RoomEntry> all)
    {
        var have = new Dictionary<RoomEntry, int>();

        foreach (var entry in sent)
        {
            have[entry] = have.GetValueOrDefault(entry) + 1;
        }

        var missing = new List<RoomEntry>();

        foreach (var entry in all)
        {
            if (have.GetValueOrDefault(entry) > 0)
            {
                have[entry]--;
            }
            else
            {
                missing.Add(entry);
            }
        }

        return missing;
    }

    /// <summary>A task that completes the next time anything in the room changes.</summary>
    public Task Changed
    {
        get
        {
            lock (_gate)
            {
                return _changed.Task;
            }
        }
    }

    /// <summary>Wake every waiter.</summary>
    public void Signal()
    {
        TaskCompletionSource previous;

        lock (_gate)
        {
            previous = _changed;
            _changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        previous.TrySetResult();
    }

    private void Tick()
    {
        if (_watcher is null)
        {
            Watch();
        }

        Signal();
    }

    private void Watch()
    {
        if (_disposed || !Directory.Exists(_root))
        {
            return;
        }

        try
        {
            var watcher = new FileSystemWatcher(_root)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.DirectoryName,
            };

            watcher.Changed += (_, _) => Signal();
            watcher.Created += (_, _) => Signal();
            watcher.Renamed += (_, _) => Signal();

            // A watcher that fails — too many handles, a share that stopped
            // answering — is a watcher that is not there, and the timer is
            // still there.
            watcher.Error += (_, _) => Signal();

            watcher.EnableRaisingEvents = true;

            lock (_gate)
            {
                if (_watcher is null && !_disposed)
                {
                    _watcher = watcher;
                    return;
                }
            }

            watcher.Dispose();
        }
        catch (Exception e) when (e is IOException or ArgumentException or PlatformNotSupportedException or UnauthorizedAccessException)
        {
            // No watcher, then. The timer is the whole of the mechanism on this
            // platform, and one second late is the documented floor.
        }
    }

    /// <summary>
    /// The lines from one cursor to another — or to the end — in one pass over the files.
    /// </summary>
    /// <param name="from">Where the reader was.</param>
    /// <param name="to">Where to stop, or null for the end of the room.</param>
    private RoomDelta Read(RoomCursor from, RoomCursor? to)
    {
        var entries = new List<RoomEntry>();
        var cursor = from;

        foreach (var (key, path) in Buckets())
        {
            var order = string.CompareOrdinal(key, from.Bucket);

            if (order < 0)
            {
                continue;
            }

            if (to is { } stop && string.CompareOrdinal(key, stop.Bucket) > 0)
            {
                break;
            }

            var lines = Physical(path);

            var skip = order == 0 ? Math.Min(from.Count, lines.Count) : 0;
            var end = to is { } bound && key.Equals(bound.Bucket, StringComparison.Ordinal)
                ? Math.Min(bound.Count, lines.Count)
                : lines.Count;

            for (var i = skip; i < end; i++)
            {
                entries.Add(new RoomEntry(key, lines[i]));
            }

            // Never backwards: a bucket shorter than the cursor said — a file
            // somebody truncated, against the convention — keeps the cursor
            // where it was rather than replaying what was under it.
            var here = new RoomCursor(key, end);

            if (here.IsAtOrAfter(cursor))
            {
                cursor = here;
            }
        }

        return new RoomDelta(entries, to ?? cursor);
    }

    /// <summary>Every bucket file in the room, oldest first, keyed by its relative path with forward slashes.</summary>
    private IReadOnlyList<(string Key, string Path)> Buckets()
    {
        if (!Directory.Exists(_root))
        {
            return [];
        }

        try
        {
            return
            [
                .. Directory.EnumerateFiles(_root, "*.txt", SearchOption.AllDirectories)
                    .Select(p => (Key: Path.GetRelativePath(_root, p).Replace('\\', '/'), Path: p))
                    .Where(e => RoomCursor.IsBucket(e.Key))
                    .OrderBy(e => e.Key, StringComparer.Ordinal),
            ];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>
    /// The terminated lines of a file, as <c>wc -l</c> would count them.
    /// </summary>
    /// <remarks>
    /// Split on <c>\n</c> and nothing else, then the last piece dropped: it is
    /// empty for a file that ends in a newline, and for one that does not it is
    /// a line somebody is still writing, which is not handed out until they have
    /// finished. A trailing <c>\r</c> is taken off each line rather than treated
    /// as a terminator, so a file written from Windows counts the same here as
    /// it does inside the instance. Interior blank lines are kept — they are
    /// physical lines, and a count that skipped them would disagree with the
    /// shell's.
    /// </remarks>
    internal static IReadOnlyList<string> Physical(string path)
    {
        string text;

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            text = reader.ReadToEnd();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }

        if (text.Length == 0)
        {
            return [];
        }

        var pieces = text.Split('\n');
        var lines = new List<string>(pieces.Length);

        for (var i = 0; i < pieces.Length - 1; i++)
        {
            lines.Add(pieces[i].TrimEnd('\r'));
        }

        return lines;
    }

    public void Dispose()
    {
        FileSystemWatcher? watcher;

        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            watcher = _watcher;
            _watcher = null;
        }

        _timer.Dispose();
        watcher?.Dispose();
        _writes.Dispose();

        // Anyone still waiting is woken to find nothing, which is the honest
        // answer from a feed that has closed.
        Signal();
    }
}

/// <summary>
/// The room on the wire, for a client that has a shell and <c>curl</c> and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// JSON is the API's native shape and the wrong one for a guest that is a
/// shell script: producing it means escaping every quote and backslash in
/// lines other agents wrote, and reading it means <c>jq</c>, which the image
/// does not carry and this design refuses to require. So the chat endpoints
/// also speak plain text, chosen with <c>Accept: text/plain</c> on the way in
/// and <c>Content-Type: text/plain</c> on the way out: one physical line per
/// line, the bucket it belongs to, a tab, the line as it is on disk. The
/// cursor travels in a header, where a shell reads it with one <c>sed</c>.
/// </para>
/// <para>
/// A tab, because a room line cannot start with one — the four shapes start
/// with <c>[</c> and a continuation with four spaces — and because <c>cut</c>
/// and <c>awk</c> both split on it without being told. A tab <em>inside</em> a
/// line is preserved: only the first one is the frame.
/// </para>
/// </remarks>
internal static partial class RoomWire
{
    /// <summary>What the text form is sent and received as.</summary>
    public const string ContentType = "text/plain; charset=utf-8";

    /// <summary>The header the cursor travels in, both directions.</summary>
    public const string CursorHeader = "X-Envmux-Cursor";

    /// <summary>The only bucket shape anything is allowed to append to: a day, a quarter hour.</summary>
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}/(?:[01]\d|2[0-3])(?:00|15|30|45)\.txt$")]
    private static partial Regex WritableBucket();

    /// <summary>Whether a bucket is one the API will write to.</summary>
    public static bool IsWritable(string bucket) => WritableBucket().IsMatch(bucket);

    /// <summary>Entries as text: <c>bucket</c>, a tab, the line, a newline — per line.</summary>
    public static string Format(IEnumerable<RoomEntry> entries)
    {
        var text = new StringBuilder();

        foreach (var entry in entries)
        {
            text.Append(entry.Bucket).Append('\t').Append(entry.Raw).Append('\n');
        }

        return text.ToString();
    }

    /// <summary>
    /// Text back into entries.
    /// </summary>
    /// <exception cref="FormatException">A line without a tab, or a bucket the API does not write to.</exception>
    public static IReadOnlyList<RoomEntry> Parse(string text)
    {
        var entries = new List<RoomEntry>();

        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');

            if (line.Length == 0)
            {
                continue;
            }

            var tab = line.IndexOf('\t', StringComparison.Ordinal);

            if (tab <= 0)
            {
                throw new FormatException("each line is a bucket, a tab, and the line to append");
            }

            var bucket = line[..tab];

            if (!IsWritable(bucket))
            {
                throw new FormatException($"'{bucket}' is not a bucket the room writes to — YYYY-MM-DD/HHMM.txt, on a quarter hour");
            }

            entries.Add(new RoomEntry(bucket, line[(tab + 1)..]));
        }

        return entries;
    }
}
