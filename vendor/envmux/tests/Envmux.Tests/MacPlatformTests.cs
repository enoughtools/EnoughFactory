using System.Net;
using System.Net.Sockets;
using Envmux.Docker;
using Envmux.Socks;

namespace Envmux.Tests;

public sealed class MacPlatformTests
{
    [Theory]
    [InlineData("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Chrome")]
    [InlineData("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Edge")]
    [InlineData("/Applications/Firefox.app/Contents/MacOS/firefox", "Firefox")]
    public void RecognisesBundleExecutables(string path, string expected) =>
        Assert.Equal(expected, BrowserLaunch.KindOf(path)?.ToString());

    [Fact]
    public void OwnerRequiresTheCompleteDirectedSocketTuple()
    {
        var client = new IPEndPoint(IPAddress.Loopback, 50000);
        const string Output = "p10\nn127.0.0.1:1080->127.0.0.1:50000\np20\nn127.0.0.1:50000->127.0.0.1:1080\n";
        Assert.Equal(20, MacConnectionOwner.ParseOwner(Output, client, 1080));
        Assert.Null(MacConnectionOwner.ParseOwner(Output, client, 1081));
        Assert.Null(MacConnectionOwner.ParseOwner(Output, new IPEndPoint(IPAddress.Parse("127.0.0.2"), 50000), 1080));
        Assert.Null(MacConnectionOwner.ParseOwner("pbad\nn127.0.0.1:50000->127.0.0.1:1080\n", client, 1080));
    }

    [SkippableFact]
    public async Task IdentifiesARealMacClientAndItsParent()
    {
        Skip.IfNot(OperatingSystem.IsMacOS(), "macOS process lookup");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port, deadline.Token);
        using var accepted = await listener.AcceptTcpClientAsync(deadline.Token);
        Assert.Equal(Environment.ProcessId,
            await ConnectionOwner.FindAsync((IPEndPoint)client.Client.LocalEndPoint!, port, deadline.Token));
        Assert.True(await ConnectionOwner.ParentAsync(Environment.ProcessId, deadline.Token) > 0);
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        var browsers = new LaunchedBrowsers();
        Assert.False(await browsers.ContainsAsync(Environment.ProcessId, deadline.Token));
        browsers.Add(process);
        Assert.True(await browsers.ContainsAsync(Environment.ProcessId, deadline.Token));
        using var child = System.Diagnostics.Process.Start("/bin/sleep", "10");
        Assert.NotNull(child);
        try
        {
            Assert.Equal(Environment.ProcessId, await ConnectionOwner.ParentAsync(child.Id, deadline.Token));
            Assert.True(await browsers.ContainsAsync(child.Id, deadline.Token));
        }
        finally
        {
            child.Kill();
            await child.WaitForExitAsync(deadline.Token);
        }
    }

    [SkippableFact]
    public async Task UnixSocketRestrictsAccessAndHalfClosesWithoutLosingInput()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix socket permissions");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // macOS sockaddr_un has a short path limit; /tmp avoids its long TMPDIR.
        var directory = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp", "envmux-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "docker.sock");
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await using (var listener = new UnixSocketListener(path))
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
                using var client = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                await client.ConnectAsync(new UnixDomainSocketEndPoint(path), deadline.Token);
                await using var connection = await listener.AcceptAsync(deadline.Token);
                Assert.NotNull(connection);
                await connection.CompleteWriteAsync(deadline.Token);
                var buffer = new byte[1];
                Assert.Equal(0, await client.ReceiveAsync(buffer, SocketFlags.None, deadline.Token));
                await client.SendAsync(new byte[] { 42 }, SocketFlags.None, deadline.Token);
                client.Shutdown(SocketShutdown.Send);
                Assert.Equal(1, await connection.Stream.ReadAsync(buffer, deadline.Token));
                Assert.Equal(42, buffer[0]);
                Assert.Equal(0, await connection.Stream.ReadAsync(buffer, deadline.Token));
            }

            Assert.False(File.Exists(path));
            // A dead listener leaves a filesystem entry; the singleton owner
            // must be able to replace it after a crash.
            using (var stale = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified))
            {
                stale.Bind(new UnixDomainSocketEndPoint(path));
            }

            await using var restarted = new UnixSocketListener(path);
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            Assert.Null(await restarted.AcceptAsync(cancelled.Token));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
