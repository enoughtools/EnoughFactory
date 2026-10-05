using Envmux.Host;
using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The range and the zone, expressed the way each Windows tool wants them.
/// </summary>
/// <remarks>
/// Nothing current writes a route or an NRPT rule; these spellings are what
/// <c>host unwire</c> finds an older envmux's by, and a spelling that drifted
/// would leave that wiring in place while saying there was none. The mask is
/// the odd one out: the persistent route was written by <c>route.exe</c>,
/// because the cmdlet could not write it on Windows 11 26100, and route.exe
/// predates CIDR — so it comes back out the same way.
/// </remarks>
public class WindowsNetworkTests
{
    private static HostConfig With(string cidr) => new() { Cidr = cidr };

    /// <summary>The route destination is the network, not the bridge's address.</summary>
    [Fact]
    public void TheDestinationIsTheNetworkAddress()
    {
        Assert.Equal("10.100.0.0/24", WindowsNetwork.DestinationPrefix(With("10.100.0.1/24")));
        Assert.Equal("10.100.0.0", WindowsNetwork.Destination(With("10.100.0.1/24")));
    }

    /// <summary>A prefix length, written the way route.exe reads it.</summary>
    [Theory]
    [InlineData("10.100.0.1/24", "255.255.255.0")]
    [InlineData("10.42.0.1/16", "255.255.0.0")]
    [InlineData("172.20.5.1/23", "255.255.254.0")]
    [InlineData("192.168.7.1/30", "255.255.255.252")]
    [InlineData("10.0.0.1/8", "255.0.0.0")]
    public void TheMaskIsThePrefixWrittenOut(string cidr, string expected) =>
        Assert.Equal(expected, WindowsNetwork.Mask(With(cidr)));

    /// <summary>The zone is a suffix, with exactly one dot in front of it.</summary>
    [Fact]
    public void TheZoneIsADottedSuffix()
    {
        Assert.Equal(".envmux", WindowsNetwork.Namespace(new HostConfig { DnsDomain = "envmux" }));
        Assert.Equal(".envmux", WindowsNetwork.Namespace(new HostConfig { DnsDomain = ".envmux" }));
    }

    /// <summary>Either half still there is something for <c>unwire</c> to do; neither is nothing.</summary>
    [Fact]
    public void LegacyWiringIsAnythingLeftOfEitherHalf()
    {
        Assert.False(new WiringStatus(null, null).Any);
        Assert.True(new WiringStatus("192.168.19.47", null).Any);
        Assert.True(new WiringStatus(null, "10.100.0.2").Any);
    }
}
