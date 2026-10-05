using System.Globalization;
using System.Text;


using Envmux.Ui;

namespace Envmux.Lean;

/// <summary>Which of the three lists the keys are talking to.</summary>
internal enum LeanPane
{
    Routes,
    Tasks,
    Log,
}

/// <summary>The arrangements there are.</summary>
/// <remarks>
/// Two. What is actually reached for is "show me everything" and "show me the
/// log"; the arrangements in between only earn their keep once there are more
/// panes to arrange than this has.
/// </remarks>
internal enum LeanScreen
{
    Dashboard,
    Log,
}

/// <summary>
/// The screens, by the names <c>/screen</c> takes.
/// </summary>
/// <remarks>
/// One table, read by the parser, by the error message, and by the help. A
/// screen that can be shown but cannot be named is one that can only be
/// reached by pressing a key the right number of times.
/// </remarks>
internal static class Screens
{
    public static readonly IReadOnlyList<string> Names = ["dashboard", "log"];

    /// <summary>The screen with this name, or null if there is no such screen.</summary>
    public static LeanScreen? Parse(string name) => name.ToLowerInvariant() switch
    {
        "dashboard" => LeanScreen.Dashboard,
        "log" => LeanScreen.Log,
        _ => null,
    };
}

/// <summary>Everything the view knows that the session does not.</summary>
/// <remarks>
/// Which row is picked, which pane the keys reach, how far back the transcript
/// has been scrolled, and what is half-typed at the command line. None of it
/// belongs to the session — two UIs on one session would each have their own —
/// and all of it dies with the window.
/// </remarks>
internal sealed class LeanState
{
    public LeanScreen Screen { get; set; }

    public LeanPane Focus { get; set; } = LeanPane.Tasks;

    public int Route { get; set; }

    public int Task { get; set; }

    /// <summary>How many rows above the newest the transcript is parked.</summary>
    /// <remarks>
    /// Zero means following. Counting up from the bottom rather than down from
    /// the top is what makes following the default state rather than a state
    /// something has to keep restoring: a line arriving changes where the top
    /// is and leaves the bottom exactly where it was.
    /// </remarks>
    public int LogScroll { get; set; }

    public bool Typing { get; set; }

    public string Typed { get; set; } = "";

    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// A line arrived. Keep the reader looking at whatever they were reading.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The scroll counts rows up from the newest line, so a line arriving moves
    /// the bottom and would slide a parked view down by one. Counting the new
    /// line holds the same rows on screen.
    /// </para>
    /// <para>
    /// It is also right when the ring is full and an old line is dropped to
    /// make room: the window is measured from the end, the end moved by one,
    /// and so did the beginning. Following — a scroll of zero — is left alone,
    /// which is what makes following the state that needs no upkeep.
    /// </para>
    /// </remarks>
    public void Logged()
    {
        if (LogScroll > 0)
        {
            LogScroll++;
        }
    }
}

/// <summary>A composed frame: the rows, and where the cursor goes.</summary>
internal sealed record LeanFrameResult(IReadOnlyList<string> Rows, (int X, int Y)? Caret);

/// <summary>
/// The session, turned into rows of text.
/// </summary>
/// <remarks>
/// <para>
/// A function of the session and the view state, and nothing else. There is no
/// layout engine here and nothing to invalidate: every frame is composed from
/// scratch, because composing eighty characters by thirty rows is cheaper than
/// the bookkeeping needed to work out which of them changed.
/// </para>
/// <para>
/// Deliberately the same shapes as the windowed UI — two ruled boxes sized to
/// what is in them and an unframed transcript under them — because the two are
/// meant to be the same product with the toolkit taken out, not two designs.
/// </para>
/// </remarks>
internal static class LeanFrame
{
    /// <summary>The tallest either box is allowed to grow, rules included.</summary>
    /// <remarks>Same reasoning, and same number, as the windowed dashboard.</remarks>
    private const int BoxCap = 10;

    /// <summary>Rows spent on chrome: title, two of identity, command line, status.</summary>
    private const int Chrome = 5;

    public static LeanFrameResult Compose(Session.Session session, LeanState state, int width, int height)
    {
        var rows = new List<string>(height);

        // Too small to say anything useful in. One honest line beats a layout
        // folded into nonsense.
        if (height < Chrome + 3 || width < 24)
        {
            rows.Add(new Line(width).Ink(Palette.Amber).Put(" envmux — the window is too small").ToString());
            return new LeanFrameResult(rows, null);
        }

        rows.Add(Title(session, state, width));
        rows.AddRange(Identity(session, width));

        var middle = height - Chrome;

        if (state.Screen == LeanScreen.Log)
        {
            rows.AddRange(Log(session, state, width, middle));
        }
        else
        {
            var routes = Math.Min(BoxCap, 2 + Math.Max(1, session.Listed.Count));
            var tasks = Math.Min(BoxCap, 2 + Math.Max(1, session.Tasks.Count));

            // The transcript is never squeezed out of existence. On a screen
            // too short for both boxes at their natural size, the boxes give
            // rows back — they scroll, and the log is the thing being read.
            while (routes + tasks > middle - 3 && (routes > 3 || tasks > 3))
            {
                if (tasks >= routes && tasks > 3)
                {
                    tasks--;
                }
                else if (routes > 3)
                {
                    routes--;
                }
            }

            routes = Math.Min(routes, Math.Max(0, middle));
            tasks = Math.Min(tasks, Math.Max(0, middle - routes));

            rows.AddRange(Routes(session, state, width, routes));
            rows.AddRange(Tasks(session, state, width, tasks));
            rows.AddRange(Log(session, state, width, middle - routes - tasks));
        }

        var caret = Prompt(rows, state, width);
        rows.Add(Status(session, state, width));

        return new LeanFrameResult(rows, caret);
    }

    /// <summary>
    /// The bar. Reversed out of the accent, as the windowed one is.
    /// </summary>
    private static string Title(Session.Session session, LeanState state, int width)
    {
        var name = state.Screen == LeanScreen.Log ? "log" : "dashboard";
        var left = $" envmux — {session.Plan.Project} / {session.Plan.Session} ";

        return new Line(width)
            .On(Palette.Neon)
            .Ink(Palette.Void)
            .Put(left)
            .Pad(width - name.Length - 1)
            .Put(name)
            .Pad(width)
            .ToString();
    }

    private static IEnumerable<string> Identity(Session.Session session, int width)
    {
        yield return new Line(width)
            .Ink(Palette.Dim).Put(" image   ")
            .Ink(Palette.Text).Put(session.Plan.Image)
            .ToString();

        var address = session.Address is { Length: > 0 } held ? held : "—";

        yield return new Line(width)
            .Ink(Palette.Dim).Put(" branch  ")
            .Ink(Palette.Text).Put(session.Plan.Branch)
            .Ink(Palette.Dim).Put("  port ")
            .Ink(Palette.Cyan).Put(session.Port == 0
                ? "—"
                : session.Port.ToString(CultureInfo.InvariantCulture))
            .Ink(Palette.Dim).Put("  user ")
            .Ink(Palette.Text).Put(session.ContainerUser)
            .Ink(Palette.Dim).Put("  at ")
            .Ink(Palette.Text).Put(address)
            .ToString();
    }

    private static IEnumerable<string> Routes(
        Session.Session session,
        LeanState state,
        int width,
        int height)
    {
        var focused = state.Focus == LeanPane.Routes;
        var body = Math.Max(0, height - 2);
        var listed = session.Listed;

        if (height <= 0)
        {
            yield break;
        }

        yield return Rule(width, "routes", focused, top: true);

        if (listed.Count == 0)
        {
            var say = session.IsReady ? "nothing routed" : $"{session.Phase}…";

            foreach (var row in Empty(width, body, say, focused))
            {
                yield return row;
            }
        }
        else
        {
            var first = Window(state.Route, listed.Count, body);

            for (var i = 0; i < body; i++)
            {
                var at = first + i;

                if (at >= listed.Count)
                {
                    yield return Boxed(new Line(width), width, focused);
                    continue;
                }

                var route = listed[at];
                var line = new Line(width - 2);

                if (focused && at == state.Route)
                {
                    line.On(Palette.Selection);
                }

                // The portal is on loopback rather than on the instance, so
                // its port column is blank rather than a zero that reads like a
                // port on a machine it is not on. "pinned" is a route whose URL
                // is the one its task printed — path, token and all — which is
                // why it looks nothing like the row above it.
                var via = route.IsPortal ? " portal" : route.IsPinned ? " pinned" : " direct";
                var port = route.IsPortal
                    ? ""
                    : route.Port.ToString(CultureInfo.InvariantCulture);

                line.Ink(Palette.Acid).Put(" " + Fit(route.Name, 12))
                    .Ink(Palette.Dim).Put(port.PadLeft(6) + " ")
                    .Ink(Palette.Cyan);

                // The URL is clipped to leave the last column room rather than
                // being allowed to run into it. A long URL is not a reason to
                // stop saying which row is the portal.
                var room = Math.Max(0, width - 2 - via.Length - line.Used);
                var url = route.Url;

                line.Put(url.Length > room ? url[..room] : url)
                    .Pad(width - 2 - via.Length)
                    .Ink(route.IsPortal ? Palette.Neon : Palette.Amber)
                    .Put(via);

                yield return Boxed(line, width, focused);
            }
        }

        if (height >= 2)
        {
            yield return Rule(width, null, focused, top: false);
        }
    }

    private static IEnumerable<string> Tasks(
        Session.Session session,
        LeanState state,
        int width,
        int height)
    {
        var focused = state.Focus == LeanPane.Tasks;
        var body = Math.Max(0, height - 2);

        if (height <= 0)
        {
            yield break;
        }

        yield return Rule(width, "tasks", focused, top: true);

        if (session.Tasks.Count == 0)
        {
            var say = session.IsReady ? "no tasks declared" : "…";

            foreach (var row in Empty(width, body, say, focused))
            {
                yield return row;
            }
        }
        else
        {
            var first = Window(state.Task, session.Tasks.Count, body);

            for (var i = 0; i < body; i++)
            {
                var at = first + i;

                if (at >= session.Tasks.Count)
                {
                    yield return Boxed(new Line(width), width, focused);
                    continue;
                }

                var task = session.Tasks[at];
                var picked = focused && at == state.Task;
                var line = new Line(width - 2);

                if (picked)
                {
                    line.On(Palette.Selection);
                }

                var detail = task.State == Session.TaskState.Running && task.LastLine.Length > 0
                    ? task.LastLine
                    : task.Plan.Display;

                line.Ink(Palette.Neon).Put(task.Plan.IsInternal ? "*" : " ")
                    .Ink(Palette.Text).Put(Fit(task.Plan.Name, 12))
                    .Ink(Palette.StateColor(task.Status)).Put(Fit(task.Status, 10))
                    .Ink(Palette.Dim).Put(detail);

                yield return Boxed(line, width, focused);
            }
        }

        if (height >= 2)
        {
            yield return Rule(width, null, focused, top: false);
        }
    }

    /// <summary>
    /// The transcript. Not a box, for the same reason it is not one next door.
    /// </summary>
    private static IEnumerable<string> Log(
        Session.Session session,
        LeanState state,
        int width,
        int height)
    {
        if (height <= 0)
        {
            yield break;
        }

        var entries = session.Log.Entries;
        var scroll = Math.Clamp(state.LogScroll, 0, Math.Max(0, entries.Count - height));
        state.LogScroll = scroll;

        var first = Math.Max(0, entries.Count - height - scroll);

        for (var i = 0; i < height; i++)
        {
            var at = first + i;

            if (at >= entries.Count)
            {
                yield return "";
                continue;
            }

            var entry = entries[at];

            yield return new Line(width)
                .Ink(Palette.Ghost)
                .Put("  " + entry.At.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + " ")
                .Ink(Palette.LevelColor(entry.Level))
                .Put(entry.Message)
                .ToString();
        }
    }

    /// <summary>The command line, and where the cursor sits in it.</summary>
    private static (int X, int Y)? Prompt(List<string> rows, LeanState state, int width)
    {
        var line = new Line(width)
            .Ink(Palette.Neon).Put("▸ ")
            .Ink(Palette.Cyan);

        if (state.Typing)
        {
            line.Put(state.Typed);
        }
        else
        {
            line.Ink(Palette.Ghost).Put(": or / for a command   ? for the keys");
        }

        var y = rows.Count;
        rows.Add(line.ToString());

        // Only while typing. A cursor parked on a prompt nobody is typing into
        // is a cursor that says the keys are going somewhere they are not.
        return state.Typing ? (Math.Min(width - 1, 2 + state.Typed.Length), y) : null;
    }

    private static string Status(Session.Session session, LeanState state, int width)
    {
        var elapsed = (int)(DateTimeOffset.UtcNow - state.StartedAt).TotalSeconds;

        var (text, ink) = session.FailedWith is not null
            ? ($" failed after {elapsed}s — q to quit", Palette.Blood)
            : !session.IsReady
                ? ($" {Spinner()} {session.Phase}… {elapsed}s   (q quits)", Palette.Cyan)
                : state.Typing
                    ? (" enter run   esc back   ^c quit   /help lists everything", Palette.Dim)
                    : (Legend, Palette.Dim);

        return new Line(width).Ink(ink).Put(text).ToString();
    }

    /// <summary>The keys, as the status bar states them.</summary>
    public const string Legend =
        " q quit   o open   b browser   p portal   e editor   c shell   r restart   k restart task   x stop/start   " +
        "tab pane   : command   F1/F2 screen";

    private static char Spinner() =>
        "|/-\\"[(int)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 400 % 4)];

    // The box, drawn the way the windowed one is: double rules, name burned
    // into the top one, lit when the keys are talking to it.

    private static string Rule(int width, string? name, bool focused, bool top)
    {
        var ink = focused ? Palette.Neon : Palette.Ghost;
        var line = new Line(width).Ink(ink).Put(top ? "╔═" : "╚═");

        if (name is not null)
        {
            line.Ink(focused ? Palette.Cyan : Palette.Dim).Put(" " + name + " ").Ink(ink);
        }

        return line.Fill('═', Math.Max(0, width - line.Used - 1))
            .Put(top ? "╗" : "╝")
            .ToString();
    }

    private static string Boxed(Line content, int width, bool focused)
    {
        var ink = focused ? Palette.Neon : Palette.Ghost;

        return new Line(width)
            .Ink(ink).Put("║")
            .Raw(content.Pad(width - 2).ToString(), width - 2)
            .Ink(ink).Put("║")
            .ToString();
    }

    private static IEnumerable<string> Empty(int width, int body, string say, bool focused)
    {
        for (var i = 0; i < body; i++)
        {
            var line = new Line(width - 2);

            if (i == 0)
            {
                line.Ink(Palette.Dim).Put("  " + say);
            }

            yield return Boxed(line, width, focused);
        }
    }

    /// <summary>
    /// Which row a list of <paramref name="count"/> should start at.
    /// </summary>
    /// <remarks>
    /// Enough to keep the picked row on screen and no more. A list that
    /// recentres on every move is a list whose contents slide about under a
    /// cursor that is standing still.
    /// </remarks>
    private static int Window(int selected, int count, int body)
    {
        if (body <= 0 || count <= body)
        {
            return 0;
        }

        var first = Math.Clamp(selected - (body / 2), 0, count - body);
        return first;
    }

    private static string Fit(string text, int room) =>
        text.Length >= room ? text[..Math.Max(0, room - 1)] + " " : text.PadRight(room);

    /// <summary>
    /// A row being built, which knows how wide it has got.
    /// </summary>
    /// <remarks>
    /// The whole reason this exists: a row is a string with colour escapes in
    /// it, so its length in characters is nothing like its width on screen.
    /// Everything that has to line up — a column, a box's right-hand rule —
    /// needs the width, so the width is counted as the row is built rather than
    /// worked out again afterwards by parsing back out what was just put in.
    /// </remarks>
    private sealed class Line(int width)
    {
        private readonly StringBuilder _text = new(width * 2);

        public int Used { get; private set; }

        private int Room => Math.Max(0, width - Used);

        public Line Ink(Rgb colour)
        {
            _text.Append(LeanConsole.Fore(colour));
            return this;
        }

        public Line On(Rgb colour)
        {
            _text.Append(LeanConsole.Back(colour));
            return this;
        }

        /// <summary>
        /// Something already built, saying how wide it is.
        /// </summary>
        /// <remarks>
        /// The width has to be given, because it cannot be worked out: the
        /// string is full of colour escapes and its length is nothing like the
        /// room it takes. Getting this wrong is silent — it does not throw, it
        /// truncates whatever comes next, which is how the boxes lost their
        /// right-hand rule the first time.
        /// </remarks>
        public Line Raw(string text, int counted)
        {
            _text.Append(text);
            Used += counted;
            return this;
        }

        public Line Put(string text)
        {
            if (Room == 0 || text.Length == 0)
            {
                return this;
            }

            var take = Math.Min(text.Length, Room);

            // Never between the halves of a surrogate pair. Half of one is not
            // a character, and a terminal handed one draws a replacement box
            // and then disagrees with us about the column it is in.
            if (take < text.Length && char.IsHighSurrogate(text[take - 1]))
            {
                take--;
            }

            _text.Append(text, 0, take);
            Used += take;
            return this;
        }

        public Line Fill(char c, int count)
        {
            var take = Math.Min(count, Room);

            if (take > 0)
            {
                _text.Append(c, take);
                Used += take;
            }

            return this;
        }

        public Line Pad(int to) => Fill(' ', Math.Max(0, to - Used));

        public override string ToString() => _text.ToString();
    }
}
