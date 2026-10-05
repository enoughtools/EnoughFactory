using System.Runtime.InteropServices;

namespace Envmux.Ui;

/// <summary>
/// The console's modes, taken before the UI does and handed back after it.
/// </summary>
/// <remarks>
/// <para>
/// Consolonia draws through the console buffer API rather than through escape
/// sequences, so it clears the flags that would get in the way. One of them is
/// <c>ENABLE_PROCESSED_OUTPUT</c>, which is what makes the console treat CR and
/// LF as control characters instead of as characters to draw. Measured on
/// Windows Terminal, the output mode goes from <c>0x0007</c> to <c>0x0018</c>
/// for the life of the window.
/// </para>
/// <para>
/// It is never put back. Nothing notices while the window is up, because a
/// window drawn cell by cell writes no newlines — it notices the moment the
/// window comes down and the exit starts printing, and what it prints arrives
/// as one unbroken line studded with ♪ and ◙, which are CP437's glyphs for
/// 0x0D and 0x0A. The shell sets the mode the way it wants it when it takes its
/// prompt back, which is exactly why the damage stops where envmux stops
/// writing and the prompt below it looks fine.
/// </para>
/// <para>
/// Saved and restored rather than set to a known-good constant: what was there
/// before is the only correct answer, and it is not the same under Windows
/// Terminal, conhost, and whatever someone runs this under next. Everywhere
/// that is not Windows this is nothing at all — a POSIX terminal is put back by
/// Consolonia's own restore, and there are no mode flags to carry.
/// </para>
/// </remarks>
internal readonly struct ConsoleModes
{
    /// <summary>The standard handles, as the Windows API numbers them.</summary>
    private const int Input = -10;

    private const int Output = -11;

    private readonly uint _input;
    private readonly uint _output;

    /// <summary>Whether there is anything to put back.</summary>
    private readonly bool _taken;

    private ConsoleModes(uint input, uint output)
    {
        _input = input;
        _output = output;
        _taken = true;
    }

    /// <summary>
    /// Read the modes as they are now, before anything has changed them.
    /// </summary>
    /// <remarks>
    /// Best effort: a console that will not answer is one this cannot help, and
    /// failing to read a flag is not a reason to refuse to start a window.
    /// </remarks>
    public static ConsoleModes Save()
    {
        if (!OperatingSystem.IsWindows())
        {
            return default;
        }

        return GetConsoleMode(GetStdHandle(Output), out var output)
               && GetConsoleMode(GetStdHandle(Input), out var input)
            ? new ConsoleModes(input, output)
            : default;
    }

    /// <summary>
    /// Ask the console to act on escape sequences rather than print them.
    /// </summary>
    /// <remarks>
    /// For the lean UI, which draws with ANSI and nothing else. Windows
    /// Terminal arrives with this on and conhost does not, and the difference
    /// between the two is a screen of legible output and a screen of
    /// <c>[38;2;255;43;214m</c>. Nothing to undo separately: whatever the mode
    /// was is already saved, and <see cref="Restore"/> puts it back.
    /// </remarks>
    public static void EnableVirtualTerminal()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var handle = GetStdHandle(Output);

        if (GetConsoleMode(handle, out var mode))
        {
            _ = SetConsoleMode(handle, mode | VirtualTerminalProcessing);
        }
    }

    private const uint VirtualTerminalProcessing = 0x0004;

    /// <summary>Put them back, so ordinary writes are ordinary again.</summary>
    public void Restore()
    {
        if (!_taken || !OperatingSystem.IsWindows())
        {
            return;
        }

        // Output first. It is the half whose absence is visible, and if the
        // second call fails the first has still done the useful part.
        _ = SetConsoleMode(GetStdHandle(Output), _output);
        _ = SetConsoleMode(GetStdHandle(Input), _input);
    }

    // DllImport rather than LibraryImport: the source generator emits unsafe
    // code, and turning unsafe on for the whole program to save three
    // declarations is a poor trade. Nothing here marshals anything harder than
    // an integer.
    [DllImport("kernel32.dll")]
    private static extern nint GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetConsoleMode(nint handle, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleMode(nint handle, uint mode);
}
