using System.Collections.Concurrent;
using System.Globalization;

namespace Envmux.Session;

/// <summary>One thing that happened, and how much it matters.</summary>
/// <param name="At">When, for the timestamp column.</param>
/// <param name="Level">One of <c>debug</c>, <c>info</c>, <c>warn</c>, <c>error</c>.</param>
/// <param name="Message">What happened, in one line.</param>
internal sealed record LogEntry(DateTimeOffset At, string Level, string Message)
{
    public override string ToString() =>
        $"{At.ToString("HH:mm:ss", CultureInfo.InvariantCulture)}  {Message}";
}

/// <summary>
/// The session's event log: what the TUI shows, and what a headless run prints.
/// </summary>
/// <remarks>
/// A bounded in-memory ring. The archive had an events table, a ring buffer, and
/// a streaming endpoint so a UI could catch up on history across connections;
/// with the process and the window being the same thing, a list and an event is
/// the whole requirement.
/// </remarks>
internal sealed class SessionLog
{
    private const int Capacity = 500;
    private readonly ConcurrentQueue<LogEntry> _entries = new();

    /// <summary>Raised for every entry, on whichever thread logged it.</summary>
    public event Action<LogEntry>? Appended;

    public IReadOnlyList<LogEntry> Entries => [.. _entries];

    public void Info(string message) => Add("info", message);

    public void Warn(string message) => Add("warn", message);

    public void Error(string message) => Add("error", message);

    public void Debug(string message) => Add("debug", message);

    private void Add(string level, string message)
    {
        var entry = new LogEntry(DateTimeOffset.Now, level, message);
        _entries.Enqueue(entry);

        while (_entries.Count > Capacity && _entries.TryDequeue(out _))
        {
            // Oldest first. A session that runs all day should not grow without
            // bound to keep lines nobody will scroll back to.
        }

        // A subscriber that throws must not become the caller's problem, and
        // this is not defensive habit — it is a measured one.
        //
        // A headless run subscribes with Console.WriteLine. Interrupt a session
        // whose output is piped somewhere and the reader can die first, and the
        // next write throws IOException on a broken pipe. That write happens
        // during teardown, so the exception lands in the middle of bringing the
        // session's commits back — and the work stays in an instance while the
        // console says nothing at all, because the console is what broke.
        //
        // Logging is never the reason to abandon what was being logged.
        foreach (var subscriber in Appended?.GetInvocationList() ?? [])
        {
            try
            {
                ((Action<LogEntry>)subscriber)(entry);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException
                                          or InvalidOperationException)
            {
                // Nowhere to report this: the thing that reports is what failed.
            }
        }
    }
}
