using System.IO.Pipes;
using System.Net;
using System.Text;

using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The serial console, driven from the other end of a real pipe.
/// </summary>
/// <remarks>
/// <para>
/// Hyper-V is the pipe's server, so these tests stand in for it: a
/// <see cref="NamedPipeServerStream"/> on a name nothing else is using, written
/// to a byte at a time where that is the point. The reader has no idea it is not
/// talking to a VM.
/// </para>
/// <para>
/// What is being checked is not "does a pipe work" but the three things that
/// would quietly break an install wait — a phrase split across two reads, a pipe
/// that is not there at all, and the line that says the install is done.
/// </para>
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public class SerialConsoleTests
{
    /// <summary>A pipe name no other test will pick.</summary>
    private static string Name([System.Runtime.CompilerServices.CallerMemberName] string caller = "") =>
        $"envmux-test-{caller}-{Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <summary>Wait for something to become true, rather than for a duration.</summary>
    private static async Task<bool> EventuallyAsync(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++)
        {
            await Task.Delay(10);
        }

        return condition();
    }

    /// <summary>The plain case: a server says something, the reader has it.</summary>
    [Fact]
    public async Task ReadsWhatTheServerWrites()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync($@"\\.\pipe\{name}");
        Assert.NotNull(console);

        await accepting;

        await server.WriteAsync(Encoding.UTF8.GetBytes("2026-08-21 09:07:40 INFO IncusOS was successfully installed\n"));
        await server.FlushAsync();

        Assert.True(await EventuallyAsync(() => InstallerSays.Finished(console!)));
        Assert.Contains("IncusOS was successfully installed", console!.Text, StringComparison.Ordinal);
    }

    /// <summary>
    /// The phrase arrives in pieces, because a pipe read is not a line read.
    /// </summary>
    /// <remarks>
    /// This is the failure that would look like the console simply never said
    /// anything: the text is all there, but a matcher that only ever saw one
    /// read at a time would never see the whole phrase in one of them.
    /// </remarks>
    [Fact]
    public async Task MatchesAPhraseSplitAcrossReads()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync($@"\\.\pipe\{name}");
        Assert.NotNull(console);

        await accepting;

        foreach (var b in Encoding.UTF8.GetBytes("INFO IncusOS was successfully installed\n"))
        {
            await server.WriteAsync(new[] { b });
            await server.FlushAsync();
        }

        Assert.True(await EventuallyAsync(() => InstallerSays.Finished(console!)));
    }

    /// <summary>Nothing listening is a null, not an exception.</summary>
    /// <remarks>
    /// The whole fallback rests on this. A VM without a COM port, a build of
    /// Hyper-V that never made the pipe, an install that has already finished —
    /// all of them land here, and all of them have to mean "use the screen"
    /// rather than "the wizard fell over".
    /// </remarks>
    [Fact]
    public async Task NoPipeIsNoConsole()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Assert.Null(await SerialConsole.ConnectAsync($@"\\.\pipe\{Name()}-nothing-here"));
    }

    /// <summary>A path or a bare name, both meaning the same pipe.</summary>
    [Fact]
    public async Task TakesThePipeEitherWayItIsSpelt()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync(name);
        Assert.NotNull(console);

        await accepting;
    }

    /// <summary>Silence is silence, and not a claim that anything finished.</summary>
    [Fact]
    public async Task SaysNothingUntilItSaysSomething()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync(name);
        Assert.NotNull(console);

        await accepting;

        await server.WriteAsync(Encoding.UTF8.GetBytes("INFO Starting the installer\nINFO Writing the image\n"));
        await server.FlushAsync();

        Assert.True(await EventuallyAsync(() => console!.Text.Contains("Writing", StringComparison.Ordinal)));
        Assert.False(InstallerSays.Finished(console!));
        Assert.False(InstallerSays.Failed(console!));
    }

    /// <summary>
    /// The address, taken from the line the guest prints it on.
    /// </summary>
    /// <remarks>
    /// This is the real one, copied from a VM that had just finished its first
    /// boot. It is the answer to a question Windows cannot answer on its own:
    /// IncusOS runs no KVP daemon, so Hyper-V does not know the guest's address,
    /// and the neighbour table has no entry for a machine nothing has talked to.
    /// </remarks>
    [Fact]
    public void ReadsTheAddressOffTheStatusLine()
    {
        const string Console = """
            2026-08-21 09:51:37 INFO Bringing up the network
            2026-08-21 09:52:05 INFO System is ready version=202608201218
            WARNING: Some encryption recovery keys have not been retrieved yet!
            Installed application(s): incus(7.3 [202608201218])
            Machine: Intel(R) Core(TM) Ultra 9 285K (numa=1, sockets=1, cores=8, threads=8) (x86_64) / 16GiB memory
            Network configuration: enp0s3(192.168.19.47)
            """;

        Assert.Equal(IPAddress.Parse("192.168.19.47"), InstallerSays.Address(Console));
    }

    /// <summary>The line is redrawn, so the last address is the one it settled on.</summary>
    [Fact]
    public void PrefersTheAddressItSettledOn()
    {
        const string Console = """
            Network configuration: enp0s3(192.168.19.9)
            Network configuration: enp0s3(192.168.19.47)
            """;

        Assert.Equal(IPAddress.Parse("192.168.19.47"), InstallerSays.Address(Console));
    }

    /// <summary>More than one interface, and neither is a loopback.</summary>
    [Fact]
    public void SkipsTheOnesThatAreNotAnAddress()
    {
        const string Console = "Network configuration: lo(127.0.0.1) enp0s3(10.100.0.5)";

        Assert.Equal(IPAddress.Parse("10.100.0.5"), InstallerSays.Address(Console));
    }

    /// <summary>A lease that never arrived is not an address.</summary>
    [Fact]
    public void RejectsALinkLocalAddress() =>
        Assert.Null(InstallerSays.Address("Network configuration: enp0s3(169.254.11.2)"));

    /// <summary>Nothing said is nothing parsed — not a guess at a default.</summary>
    [Fact]
    public void NoAddressWhenItHasNotSaidOne()
    {
        Assert.Null(InstallerSays.Address(""));
        Assert.Null(InstallerSays.Address("2026-08-21 09:51:37 INFO Bringing up the network"));
    }

    /// <summary>Off a live console, not a string.</summary>
    [Fact]
    public async Task ReadsTheAddressOffAPipe()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync(name);
        Assert.NotNull(console);

        await accepting;

        await server.WriteAsync(Encoding.UTF8.GetBytes("Network configuration: enp0s3(192.168.19.47)\n"));
        await server.FlushAsync();

        Assert.True(await EventuallyAsync(() => InstallerSays.Address(console!) is not null));
        Assert.Equal(IPAddress.Parse("192.168.19.47"), InstallerSays.Address(console!));
    }

    /// <summary>The other wording of the same moment.</summary>
    [Fact]
    public async Task RemovingTheMediaCountsAsFinished()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var name = Name();

        await using var server = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accepting = server.WaitForConnectionAsync();

        await using var console = await SerialConsole.ConnectAsync(name);
        Assert.NotNull(console);

        await accepting;

        await server.WriteAsync(
            Encoding.UTF8.GetBytes("INFO Please remove the install media to complete the installation\n"));

        await server.FlushAsync();

        Assert.True(await EventuallyAsync(() => InstallerSays.Finished(console!)));
    }
}
