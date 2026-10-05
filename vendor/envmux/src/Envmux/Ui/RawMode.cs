using System.Runtime.InteropServices;

using Envmux.Process;

namespace Envmux.Ui;

/// <summary>
/// The console handed over to something else, byte for byte, and taken back.
/// </summary>
/// <remarks>
/// <para>
/// Needed the moment envmux stopped handing the terminal to a child process.
/// <c>docker exec -it</c> owned the console for the duration and did all of this
/// itself; a pty on the other end of a websocket does not, so this side has to
/// stop interpreting what is typed at it and forward the bytes.
/// </para>
/// <para>
/// Three things are turned off. <b>Line input</b>, or nothing arrives until
/// somebody presses enter and a full-screen program never draws. <b>Echo</b>, or
/// every keystroke appears twice — once from here and once from the program that
/// received it. And <b>processed input</b>, which is the one that matters: with
/// it on, Ctrl-C is a console control event rather than a byte, .NET turns that
/// into <c>CancelKeyPress</c>, and envmux quits the session instead of
/// interrupting whatever the person was actually trying to interrupt.
/// </para>
/// <para>
/// Restoring is not optional and not best-effort. A terminal left in raw mode
/// after the process exits is a shell with no echo and no line editing, which
/// reads as the terminal having broken rather than as envmux having failed to
/// tidy up — so this is a disposable and every path through the attach goes
/// through it.
/// </para>
/// </remarks>
internal sealed class RawMode : IDisposable
{
    private readonly uint _input;
    private readonly bool _windows;
    private readonly bool _taken;
    private readonly bool _controlC;
    private bool _restored;

    private RawMode(bool windows, uint input, bool taken, bool controlC)
    {
        _windows = windows;
        _input = input;
        _taken = taken;
        _controlC = controlC;
    }

    /// <summary>
    /// Take the console, or take nothing and say so.
    /// </summary>
    /// <remarks>
    /// A redirected stdin has no modes to change and needs none: the bytes
    /// already arrive as bytes. Returning a no-op rather than refusing is what
    /// lets a piped session and an interactive one take the same code path.
    /// </remarks>
    public static RawMode Enter()
    {
        var controlC = false;

        try
        {
            // Portable, and the half that matters most: it is what stops .NET
            // turning Ctrl-C into a request to quit the session.
            if (!Console.IsInputRedirected)
            {
                Console.TreatControlCAsInput = true;
                controlC = true;
            }
        }
        catch (Exception e) when (e is IOException or PlatformNotSupportedException)
        {
            // No console to ask. The stream still works.
        }

        if (OperatingSystem.IsWindows())
        {
            var handle = GetStdHandle(Input);

            if (GetConsoleMode(handle, out var mode))
            {
                var raw = mode & ~(EnableLineInput | EnableEchoInput | EnableProcessedInput);

                // And ask for the other direction: arrow keys and function keys
                // as escape sequences rather than as console key records, which
                // is what the far end expects to receive.
                raw |= EnableVirtualTerminalInput;

                if (SetConsoleMode(handle, raw))
                {
                    return new RawMode(true, mode, true, controlC);
                }
            }

            return new RawMode(true, 0, false, controlC);
        }

        // POSIX has no such API in the BCL, and termios through P/Invoke needs
        // unsafe for a struct layout that differs per platform. `stty` is on
        // every machine this could run on — see below for the flag that is not
        // spelt the same way on all of them.
        Stty("raw -echo");
        return new RawMode(false, 0, true, controlC);
    }

    public void Dispose()
    {
        if (_restored)
        {
            return;
        }

        _restored = true;

        if (_taken)
        {
            if (_windows)
            {
                _ = SetConsoleMode(GetStdHandle(Input), _input);
            }
            else
            {
                Stty("sane");
            }
        }

        if (!_controlC)
        {
            return;
        }

        try
        {
            Console.TreatControlCAsInput = false;
        }
        catch (Exception e) when (e is IOException or PlatformNotSupportedException)
        {
            // The console went while we were using it, which is one of the ways
            // a session ends.
        }
    }

    /// <summary>
    /// Run <c>stty</c> against the real terminal, not against our stdin.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Naming the terminal, because the process's own stdin may be redirected
    /// and <c>stty</c> would then be configuring a pipe. The flag for that
    /// differs: GNU coreutils spells it <c>-F</c> and the BSD one macOS ships
    /// spells it <c>-f</c>, and each rejects the other's.
    /// </para>
    /// <para>
    /// Failures are ignored — there is no terminal to configure on a machine
    /// where this does not work, and refusing to open a shell over it would be
    /// worse. Which also means this path is quiet when it is wrong, and it is
    /// the least exercised code in the file: v1 builds a host on Windows only,
    /// so nothing here has been run against a real macOS or Linux terminal.
    /// </para>
    /// </remarks>
    private static void Stty(string arguments)
    {
        // BSD stty, which is what macOS has. Linux and the GNU tools take -F.
        var file = OperatingSystem.IsMacOS() ? "-f" : "-F";

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));

            _ = ProcessRunner
                .RunAsync("stty", [file, "/dev/tty", .. arguments.Split(' ')], ct: timeout.Token)
                .GetAwaiter().GetResult();
        }
        catch (Exception e) when (e is ProcessException or OperationCanceledException)
        {
            // No stty, or no controlling terminal.
        }
    }

    private const int Input = -10;

    private const uint EnableProcessedInput = 0x0001;
    private const uint EnableLineInput = 0x0002;
    private const uint EnableEchoInput = 0x0004;
    private const uint EnableVirtualTerminalInput = 0x0200;

    [DllImport("kernel32.dll")]
    private static extern nint GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetConsoleMode(nint handle, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleMode(nint handle, uint mode);
}
