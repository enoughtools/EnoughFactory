using System.Globalization;
using System.Text;


using Envmux.Ui;

namespace Envmux.Lean;

/// <summary>
/// The screen, as escape sequences and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// The whole of the lean UI's dependency on a terminal. There is no toolkit
/// under this: no dispatcher, no layout pass, no retained visual tree, no
/// render loop that has to be kept alive. A frame is a list of strings, this
/// writes the ones that changed, and that is the entire contract.
/// </para>
/// <para>
/// Rows carry their own colour escapes, so a row is compared to the last one
/// drawn as a plain string — two rows that differ only in colour differ as
/// strings, which is exactly the answer wanted. Only changed rows are written,
/// because a session that logs a line a second should not repaint a screen a
/// second on a link where that is visible.
/// </para>
/// </remarks>
internal sealed class LeanConsole : IDisposable
{
    /// <summary>Everything drawn sits on this, and erase-to-end-of-line keeps it.</summary>
    private static readonly string Ground = Back(Palette.Void) + Fore(Palette.Text);

    private readonly ConsoleModes _modes;
    private readonly Encoding? _encoding;
    private readonly StringBuilder _out = new(16 * 1024);

    private string[] _drawn = [];
    private bool _suspended;
    private bool _disposed;

    public int Width { get; private set; }

    public int Height { get; private set; }

    public LeanConsole()
    {
        _modes = ConsoleModes.Save();

        // Only when it is not already right. Assigning it rebuilds the console
        // streams, and doing that for no reason is a flicker and a risk on a
        // terminal that was already speaking UTF-8.
        if (Console.OutputEncoding.CodePage != Encoding.UTF8.CodePage)
        {
            _encoding = Console.OutputEncoding;
            Console.OutputEncoding = Encoding.UTF8;
        }

        Take();
        Measure();
    }

    /// <summary>
    /// Claim the terminal: escape sequences on, alternate screen, no cursor.
    /// </summary>
    /// <remarks>
    /// Ctrl-C as input rather than as a signal, because in here it is the key
    /// that quits and the quit has to run teardown. Left as a signal it would
    /// race the shutdown handler in Program and half the time win.
    /// </remarks>
    private void Take()
    {
        ConsoleModes.EnableVirtualTerminal();

        try
        {
            Console.TreatControlCAsInput = true;
        }
        catch (IOException)
        {
            // No console to set it on. The read loop copes; there is simply
            // nothing to read.
        }

        Write("\e[?1049h\e[?25l" + Ground + "\e[2J");
        _drawn = [];
    }

    /// <summary>Give it back, in the state it was found in.</summary>
    private void Release()
    {
        Write(Reset + "\e[?25h\e[?1049l");

        try
        {
            Console.TreatControlCAsInput = false;
        }
        catch (IOException)
        {
            // As above.
        }

        _modes.Restore();
    }

    /// <summary>
    /// Whether the terminal is a different size than it was.
    /// </summary>
    /// <remarks>
    /// Polled rather than subscribed. .NET raises nothing for a resize on any
    /// platform, and the loop is already awake every few dozen milliseconds
    /// deciding whether to draw — so asking costs one syscall on a tick that
    /// was happening anyway, and needs no signal handler to get wrong.
    /// </remarks>
    public bool Resized()
    {
        var (width, height) = (Width, Height);
        Measure();

        if (width == Width && height == Height)
        {
            return false;
        }

        // Everything, because every row moved. There is no retained buffer to
        // rescue here — the terminal keeps what it was given, and what it was
        // given was laid out for the old width.
        Invalidate();
        return true;
    }

    private void Measure()
    {
        try
        {
            Width = Math.Max(1, Console.WindowWidth);
            Height = Math.Max(1, Console.WindowHeight);
        }
        catch (IOException)
        {
            (Width, Height) = (80, 24);
        }
    }

    /// <summary>Forget what is on screen, so the next frame writes all of it.</summary>
    public void Invalidate()
    {
        _drawn = [];
        Write(Ground + "\e[2J");
    }

    /// <summary>
    /// Put a frame on the screen.
    /// </summary>
    /// <param name="rows">One string per row, without padding — the erase does that.</param>
    /// <param name="caret">Where to leave a visible cursor, or null to keep it hidden.</param>
    public void Frame(IReadOnlyList<string> rows, (int X, int Y)? caret)
    {
        if (_suspended)
        {
            return;
        }

        _out.Clear();

        var next = new string[Height];

        for (var y = 0; y < Height; y++)
        {
            var row = y < rows.Count ? rows[y] : "";
            next[y] = row;

            if (y < _drawn.Length && string.Equals(_drawn[y], row, StringComparison.Ordinal))
            {
                continue;
            }

            // Back to the ground colour before erasing, so the rest of the row
            // is cleared to the background of the UI rather than to whatever
            // the last colour on the row happened to be.
            _out.Append(CultureInfo.InvariantCulture, $"\e[{y + 1};1H")
                .Append(Ground)
                .Append(row)
                .Append(Ground)
                .Append("\e[K");
        }

        _out.Append(caret is { } at
            ? string.Create(CultureInfo.InvariantCulture, $"\e[{at.Y + 1};{at.X + 1}H\e[?25h")
            : "\e[?25l");

        _drawn = next;
        Write(_out.ToString());
    }

    /// <summary>
    /// Hand the terminal to something else — a shell — until it is done.
    /// </summary>
    /// <remarks>
    /// Two programs cannot own one terminal. The lean UI's answer is the honest
    /// one: put the terminal back exactly as it was found, let the other program
    /// have it, and take it again afterwards. The alternate screen is what makes
    /// this free — whatever the shell did is on the normal screen and the UI's
    /// screen is still underneath it, untouched.
    /// </remarks>
    public void Suspend()
    {
        if (_suspended)
        {
            return;
        }

        _suspended = true;
        Release();
    }

    public void Resume()
    {
        if (!_suspended)
        {
            return;
        }

        _suspended = false;
        Take();
        Measure();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        if (!_suspended)
        {
            Release();
        }

        if (_encoding is { } encoding)
        {
            Console.OutputEncoding = encoding;
        }
    }

    private static void Write(string text)
    {
        try
        {
            Console.Out.Write(text);
            Console.Out.Flush();
        }
        catch (IOException)
        {
            // The terminal went away mid-frame. There is nowhere to report that
            // to, and the session's teardown is already the next thing to run.
        }
    }

    // The escape sequences, named once.

    public const string Reset = "\e[0m";

    public static string Fore(Rgb c) =>
        string.Create(CultureInfo.InvariantCulture, $"\e[38;2;{c.R};{c.G};{c.B}m");

    public static string Back(Rgb c) =>
        string.Create(CultureInfo.InvariantCulture, $"\e[48;2;{c.R};{c.G};{c.B}m");
}
