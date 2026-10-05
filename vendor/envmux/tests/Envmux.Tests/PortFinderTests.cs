using System.Net;
using System.Net.Sockets;

using Envmux.Routing;

namespace Envmux.Tests;

public class PortFinderTests
{
    [Fact]
    public void WalksUpwardFromThePreferredPort() =>
        Assert.Equal([8080, 8081, 8082], PortFinder.Candidates(8080).Take(3));

    [Fact]
    public void StopsAfterTheAttemptLimit() =>
        Assert.Equal(PortFinder.Attempts, PortFinder.Candidates(8080).Count());

    [Fact]
    public void DoesNotWrapPastTheLastPort() =>
        Assert.Equal([65534, 65535], PortFinder.Candidates(65534));

    [Fact]
    public void SkipsAPortSomethingElseIsHolding()
    {
        // Hold a real port, then ask for it: the walk should step over it.
        using var held = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        held.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        held.Listen();
        var taken = ((IPEndPoint)held.LocalEndPoint!).Port;

        Assert.False(PortFinder.IsFree(taken));

        var found = PortFinder.FirstFree(taken);
        Assert.NotNull(found);
        Assert.NotEqual(taken, found);
        Assert.InRange(found!.Value, taken + 1, taken + PortFinder.Attempts - 1);
    }

    [Fact]
    public void ReleasingThePortReleasesTheClaim()
    {
        // The whole reason there is no stale-claim case to handle.
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        socket.Listen();
        var port = ((IPEndPoint)socket.LocalEndPoint!).Port;

        Assert.False(PortFinder.IsFree(port));
        socket.Dispose();
        Assert.True(PortFinder.IsFree(port));
    }
}
