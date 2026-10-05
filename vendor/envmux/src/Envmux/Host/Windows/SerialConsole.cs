using System.IO.Pipes;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Envmux.Host.Windows;

/// <summary>
/// The guest's serial console, read off the named pipe Hyper-V puts it on.
/// </summary>
/// <remarks>
/// <para>
/// This exists to answer one question that has no other answer: whether the
/// installer has finished. It finishes in seconds and then waits to be told the
/// media has gone — machine running, no address, no API, no guest agent — so
/// every state envmux can poll is identical before and after. The only thing
/// that changes is a line of text on a console.
/// </para>
/// <para>
/// So the guest is told to put its console on <c>ttyS0</c> by the kernel seed,
/// the VM's COM1 is pointed at a named pipe, and this reads it. A line that
/// either arrived or did not, in place of a heuristic about screens that have
/// stopped changing.
/// </para>
/// <para>
/// Hyper-V owns the pipe and this connects to it as a client. It is opened
/// read-only and nothing is ever written back: the console is being listened to,
/// not driven, and a stray byte into an installer's tty is not a thing to risk
/// for no gain.
/// </para>
/// <para>
/// Every failure here is silent by design. A guest that ignores the seed, a
/// build without the COM port, a pipe that never appears — all of them mean
/// "no serial console", which is a fallback rather than a failure. The screen is
/// still there.
/// </para>
/// </remarks>
internal sealed class SerialConsole : IAsyncDisposable
{
    private readonly NamedPipeClientStream _pipe;
    private readonly CancellationTokenSource _reading = new();
    private readonly StringBuilder _text = new();
    private readonly Lock _gate = new();
    private readonly Task _pump;
    private bool _disposed;

    /// <summary>How much of the console is kept.</summary>
    /// <remarks>
    /// An install's log is a few kilobytes. This is the ceiling for the case
    /// where something in the guest decides to log in a loop, so that a wait
    /// does not turn into a memory profile.
    /// </remarks>
    private const int Capacity = 256 * 1024;

    private SerialConsole(NamedPipeClientStream pipe)
    {
        _pipe = pipe;
        _pump = Task.Run(PumpAsync);
    }

    /// <summary>
    /// Connect to a VM's console, or return null if there is nothing to connect to.
    /// </summary>
    /// <remarks>
    /// A short timeout, because this is opportunistic. The pipe only exists
    /// while the VM is running and only if the COM port was configured, and
    /// waiting on it would be waiting on something that may never come.
    /// </remarks>
    public static async Task<SerialConsole?> ConnectAsync(string pipePath, CancellationToken ct = default)
    {
        // NamedPipeClientStream wants the name, not the path: it puts the
        // \\.\pipe\ back itself, and given the whole thing it looks for a pipe
        // called "\\.\pipe\\\\.\pipe\x".
        const string Prefix = @"\\.\pipe\";

        var name = pipePath.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)
            ? pipePath[Prefix.Length..]
            : pipePath;

        var pipe = new NamedPipeClientStream(".", name, PipeDirection.In, PipeOptions.Asynchronous);

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));

            await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);

            return new SerialConsole(pipe);
        }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException or IOException
                                      or UnauthorizedAccessException or NotSupportedException)
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            return null;
        }
    }

    /// <summary>Everything the console has said since this connected.</summary>
    public string Text
    {
        get
        {
            lock (_gate)
            {
                return _text.ToString();
            }
        }
    }

    /// <summary>Whether the console has said something, in any casing.</summary>
    public bool Said(string phrase) =>
        Text.Contains(phrase, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Read until the pipe closes or this is disposed.
    /// </summary>
    /// <remarks>
    /// Decoded incrementally rather than per read, because a read can land in
    /// the middle of a multi-byte character and decoding each chunk on its own
    /// would turn that into two replacement characters.
    /// </remarks>
    private async Task PumpAsync()
    {
        var buffer = new byte[4096];
        var decoder = Encoding.UTF8.GetDecoder();
        var characters = new char[4096];

        try
        {
            while (!_reading.IsCancellationRequested)
            {
                var read = await _pipe.ReadAsync(buffer, _reading.Token).ConfigureAwait(false);

                if (read == 0)
                {
                    break;
                }

                var decoded = decoder.GetChars(buffer, 0, read, characters, 0);

                lock (_gate)
                {
                    _text.Append(characters, 0, decoded);

                    if (_text.Length > Capacity)
                    {
                        _text.Remove(0, _text.Length - Capacity);
                    }
                }
            }
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException)
        {
            // The VM stopped, or we are being taken down. Whatever was read is
            // still readable; there is simply no more of it.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        await _reading.CancelAsync().ConfigureAwait(false);
        await _pipe.DisposeAsync().ConfigureAwait(false);

        try
        {
            await _pump.WaitAsync(TimeSpan.FromSeconds(2), CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException)
        {
            // A read that will not unblock. The stream is gone underneath it.
        }

        _reading.Dispose();
    }
}

/// <summary>
/// What the IncusOS installer says, and the words worth waiting for.
/// </summary>
/// <remarks>
/// Matched on a fragment rather than a whole line, so that a timestamp, a log
/// level or a change of punctuation does not stop it matching. The observed line
/// is:
/// <code>
/// 2026-08-21 09:07:40 INFO IncusOS was successfully installed
/// 2026-08-21 09:07:40 INFO Please remove the install media to complete the installation
/// </code>
/// </remarks>
internal static partial class InstallerSays
{
    /// <summary>The installer has written the image and is waiting to be finished.</summary>
    public const string Installed = "successfully installed";

    /// <summary>The same moment, said the other way, in case the first is reworded.</summary>
    public const string RemoveMedia = "remove the install media";

    /// <summary>Whether a console has reported the install as done.</summary>
    public static bool Finished(SerialConsole console) =>
        console.Said(Installed) || console.Said(RemoveMedia);

    /// <summary>
    /// The address the guest says it took, if it has said.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Worth having because the Windows side of this is genuinely awkward.
    /// IncusOS runs no KVP daemon, so Hyper-V cannot report the guest's address,
    /// and the neighbour table only holds addresses Windows has had a reason to
    /// resolve — which it has not, because the VM came up, took a lease and
    /// started answering without Windows ever addressing it. A machine that is
    /// up and reachable is invisible from that side until something asks for it.
    /// </para>
    /// <para>
    /// The guest, meanwhile, simply says it. Its status line reads
    /// <c>Network configuration: enp0s3(192.168.19.47)</c>, which is the answer
    /// without a scan, a guess or a daemon.
    /// </para>
    /// <para>
    /// The last one wins, because the line is redrawn: an address seen during
    /// DHCP is superseded by the one it settled on.
    /// </para>
    /// </remarks>
    public static IPAddress? Address(SerialConsole console) =>
        Address(console.Text);

    /// <summary>The same, over text that came from somewhere else.</summary>
    /// <param name="text">Console output, or any part of it.</param>
    public static IPAddress? Address(string text)
    {
        // Interfaces first, because that line is the guest stating its own
        // address rather than mentioning somebody else's.
        var found = Interface().Matches(text)
            .Select(m => m.Groups["ip"].Value)
            .ToList();

        if (found.Count == 0)
        {
            found = Configuration().Matches(text)
                .SelectMany(m => Any().Matches(m.Groups["rest"].Value).Select(a => a.Value))
                .ToList();
        }

        // Reversed, so a settled address beats a transient one, and filtered,
        // because a console will happily mention a loopback or a netmask.
        foreach (var candidate in Enumerable.Reverse(found))
        {
            if (IPAddress.TryParse(candidate, out var address) &&
                address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
                !IPAddress.IsLoopback(address) &&
                !address.Equals(IPAddress.Any) &&
                !address.Equals(IPAddress.Broadcast) &&
                !candidate.StartsWith("169.254.", StringComparison.Ordinal))
            {
                return address;
            }
        }

        return null;
    }

    /// <summary>An interface with its address in brackets, as the status line writes it.</summary>
    [GeneratedRegex(@"[A-Za-z][A-Za-z0-9]*\((?<ip>\d{1,3}(?:\.\d{1,3}){3})\)")]
    private static partial Regex Interface();

    /// <summary>The line that carries them, for a build that spaces it differently.</summary>
    [GeneratedRegex(@"Network configuration:(?<rest>.*)", RegexOptions.IgnoreCase)]
    private static partial Regex Configuration();

    /// <summary>Any dotted quad at all.</summary>
    [GeneratedRegex(@"\d{1,3}(?:\.\d{1,3}){3}")]
    private static partial Regex Any();

    /// <summary>Whether a console has reported it as failed.</summary>
    /// <remarks>
    /// Worth watching for separately: a failed install also stops redrawing, and
    /// waiting out a twenty minute deadline for something that already said it
    /// went wrong is the worst of both.
    /// </remarks>
    public static bool Failed(SerialConsole console) =>
        console.Said("install failed") || console.Said("failed to install");
}
