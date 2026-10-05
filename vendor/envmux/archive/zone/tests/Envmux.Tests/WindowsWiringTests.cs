using System.Net;

using Envmux.Host;
using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// Wiring never steals: what is already on the workstation is read, and only
/// what is this host's is replaced without being asked.
/// </summary>
/// <remarks>
/// The case these are written around is a real one. This workstation had a
/// Hyper-V host — <c>10.100.0.0/24</c> routed to the VM, <c>.envmux</c> resolved
/// by the bridge at <c>10.100.0.1</c> — and was then pointed at an Incus on
/// another machine. The old code deleted whatever was there; the sessions on the
/// first host would have gone dark with no error anywhere. The decision is a
/// pure function precisely so that every shape of that can be pinned here,
/// without a routing table to set up and put back.
/// </remarks>
public class WindowsWiringTests
{
    private static readonly IPAddress Vm = IPAddress.Parse("192.168.19.47");
    private static readonly IPAddress Remote = IPAddress.Parse("192.168.19.43");

    /// <summary>The Hyper-V host as it was wired: the bridge answers the zone.</summary>
    private static HostConfig Built => new() { Cidr = "10.100.0.1/24", DnsDomain = "envmux" };

    /// <summary>The same range and zone on a daemon envmux attached to: the utility instance answers.</summary>
    private static HostConfig Attached => Built with { Resolver = "10.100.0.2", Gateway = Remote.ToString() };

    [Fact]
    public void NothingWiredIsNothingToSteal()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus(null, null), Attached, Remote);

        Assert.Equal(WiringVerdict.Wire, decision.Verdict);
        Assert.Null(decision.Message);
    }

    /// <summary>Re-wiring the same values is a no-op, not a conflict and not a change.</summary>
    [Fact]
    public void TheSameValuesAreTheSame()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.43", "10.100.0.2"), Attached, Remote);

        Assert.Equal(WiringVerdict.Same, decision.Verdict);
    }

    /// <summary>Addresses are compared as addresses, so how PowerShell spelt one is never a conflict.</summary>
    [Fact]
    public void SpellingIsNotAConflict()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus(" 192.168.19.43 ", "10.100.0.2 "), Attached, Remote);

        Assert.Equal(WiringVerdict.Same, decision.Verdict);
    }

    /// <summary>
    /// The swap: the same prefix and the same zone, wired to a different host.
    /// </summary>
    /// <remarks>
    /// Refused, and the refusal has to be enough to act on by itself — what is
    /// wired to where now, what each would become, and both ways out.
    /// </remarks>
    [Fact]
    public void AnotherHostsRangeAndZoneAreRefusedNamingBothSides()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.47", "10.100.0.1"), Attached, Remote);

        Assert.True(decision.IsConflict);

        var message = decision.Message!;

        Assert.Contains("route 10.100.0.0/24 → 192.168.19.47", message, StringComparison.Ordinal);
        Assert.Contains("→ 192.168.19.43", message, StringComparison.Ordinal);
        Assert.Contains("nrpt  .envmux → 10.100.0.1", message, StringComparison.Ordinal);
        Assert.Contains("→ 10.100.0.2", message, StringComparison.Ordinal);
        Assert.Contains("--force", message, StringComparison.Ordinal);
        Assert.Contains("--cidr", message, StringComparison.Ordinal);
        Assert.Contains("--domain", message, StringComparison.Ordinal);
        Assert.Contains("Nothing has been changed", message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A new range beside an old host still collides on the zone, and says only that.
    /// </summary>
    /// <remarks>
    /// <c>envmux install</c> suggests a free range on its own, so this is what a
    /// second host on a workstation actually hits: the default zone. Offering
    /// <c>--cidr</c> here would be advice that fixes nothing.
    /// </remarks>
    [Fact]
    public void ADifferentRangeWithTheSameZoneConflictsOnTheZoneAlone()
    {
        var second = new HostConfig { Cidr = "10.90.0.1/24", DnsDomain = "envmux", Resolver = "10.90.0.2" };

        var decision = WindowsNetwork.Decide(new WiringStatus(null, "10.100.0.1"), second, Remote);

        Assert.True(decision.IsConflict);
        Assert.Contains("nrpt  .envmux → 10.100.0.1", decision.Message!, StringComparison.Ordinal);
        Assert.Contains("--domain", decision.Message!, StringComparison.Ordinal);
        Assert.DoesNotContain("--cidr", decision.Message!, StringComparison.Ordinal);
    }

    /// <summary>
    /// Our own rule, from before the resolver moved off the bridge, is ours to move.
    /// </summary>
    /// <remarks>
    /// The route already goes to this gateway, and the server the zone is asked
    /// of sits inside that routed range: it is this host's earlier wiring, so
    /// moving it takes nothing from anybody and needs no <c>--force</c>.
    /// </remarks>
    [Fact]
    public void OurOwnEarlierResolverIsReplacedWithoutForce()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.43", "10.100.0.1"), Attached, Remote);

        Assert.Equal(WiringVerdict.Wire, decision.Verdict);
    }

    /// <summary>The same rule under somebody else's route is not ours, however plausible the address.</summary>
    [Fact]
    public void AResolverInsideTheRangeIsNotOursWhenTheRouteIsNot()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.47", "10.100.0.1"), Attached, Remote);

        Assert.True(decision.IsConflict);
    }

    /// <summary>
    /// The same address is not the same resolver while the range goes to another host.
    /// </summary>
    /// <remarks>
    /// The swap, asked early — before the trust token is spent, and so before
    /// the new host has a utility instance. Both hosts keep their bridge at
    /// <c>10.100.0.1</c>, and the rule that names it is the old VM's for as long
    /// as the route is. Saying "already this host" there would be wrong in the
    /// one sentence somebody reads before typing <c>--force</c>.
    /// </remarks>
    [Fact]
    public void TheSameResolverAddressBehindAnotherHostsRouteIsTheOtherHosts()
    {
        var swapping = Built with { Gateway = Remote.ToString() };

        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.47", "10.100.0.1"), swapping, Remote);

        Assert.True(decision.IsConflict);
        Assert.Contains("route 10.100.0.0/24 → 192.168.19.47      --force re-points it → 192.168.19.43", decision.Message!, StringComparison.Ordinal);
        Assert.Contains("nrpt  .envmux → 10.100.0.1      the other host's, at the same address", decision.Message!, StringComparison.Ordinal);
        Assert.DoesNotContain("already this host", decision.Message!, StringComparison.Ordinal);

        // And once the route is this host's, the same rule is simply right.
        Assert.Equal(
            WiringVerdict.Same,
            WindowsNetwork.Decide(new WiringStatus("192.168.19.43", "10.100.0.1"), swapping, Remote).Verdict);
    }

    /// <summary>
    /// Before there is a host, anything already routed is somebody else's.
    /// </summary>
    /// <remarks>
    /// <c>envmux install</c> asks this while the range is still a choice — for
    /// Hyper-V before a VM is built on it, for Incus before the network is
    /// created — and has no gateway to compare against yet.
    /// </remarks>
    [Fact]
    public void WithNoGatewayYetARoutedPrefixIsTaken()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.47", null), Built, gateway: null);

        Assert.True(decision.IsConflict);
        Assert.Contains("the new host", decision.Message!, StringComparison.Ordinal);
    }

    /// <summary>An on-link route is a directly attached network, and is said as one.</summary>
    [Fact]
    public void AnOnLinkRouteIsNamedAsOne()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("0.0.0.0", null), Attached, Remote);

        Assert.True(decision.IsConflict);
        Assert.Contains("on-link", decision.Message!, StringComparison.Ordinal);
    }

    /// <summary>A rule with two servers is not ours even when one of them is.</summary>
    [Fact]
    public void ARuleWithAnExtraServerIsNotOurs()
    {
        var decision = WindowsNetwork.Decide(new WiringStatus("192.168.19.43", "10.100.0.2,8.8.8.8"), Attached, Remote);

        Assert.True(decision.IsConflict);
    }

    /// <summary>NRPT is pointed at the resolver host.json names — the bridge only when it names none.</summary>
    [Fact]
    public void TheScriptPointsTheZoneAtTheResolver()
    {
        Assert.Contains("\"10.100.0.2\"", WindowsNetwork.Script(Attached, Remote).Last(), StringComparison.Ordinal);
        Assert.Contains("\"10.100.0.1\"", WindowsNetwork.Script(Built, Vm).Last(), StringComparison.Ordinal);
    }

    /// <summary>
    /// On a wired workstation the printed script is the whole replacement.
    /// </summary>
    /// <remarks>
    /// The two add lines alone fail there — <c>route.exe</c> refuses a prefix
    /// that is present, and a second rule leaves the zone with two answers — so
    /// what is there comes off first, in the order it has to: each removal
    /// immediately before the thing that replaces it.
    /// </remarks>
    [Fact]
    public void ThePrintedScriptForASwapRemovesWhatIsThereFirst()
    {
        var lines = WindowsNetwork
            .Script(Attached, Remote, new WiringStatus("192.168.19.47", "10.100.0.1"))
            .ToList();

        Assert.Equal(4, lines.Count);
        Assert.Equal("route delete 10.100.0.0 mask 255.255.255.0", lines[0]);
        Assert.Equal("route -p add 10.100.0.0 mask 255.255.255.0 192.168.19.43", lines[1]);
        Assert.StartsWith("Get-DnsClientNrptRule", lines[2], StringComparison.Ordinal);
        Assert.Contains("\".envmux\"", lines[2], StringComparison.Ordinal);
        Assert.Contains("Remove-DnsClientNrptRule", lines[2], StringComparison.Ordinal);
        Assert.StartsWith("Add-DnsClientNrptRule", lines[3], StringComparison.Ordinal);
    }

    /// <summary>Only the half that is there is removed; a clean workstation still gets two lines.</summary>
    [Fact]
    public void ThePrintedScriptRemovesOnlyWhatIsThere()
    {
        Assert.Equal(2, WindowsNetwork.Script(Attached, Remote, new WiringStatus(null, null)).Count());

        var routeOnly = WindowsNetwork.Script(Attached, Remote, new WiringStatus("192.168.19.47", null)).ToList();

        Assert.Equal(3, routeOnly.Count);
        Assert.StartsWith("route delete", routeOnly[0], StringComparison.Ordinal);
    }

    /// <summary>The recorded gateway wins; an older host.json falls back to the API's own IPv4.</summary>
    [Theory]
    [InlineData("192.168.19.43", "192.168.19.47:8443", "192.168.19.43")]
    [InlineData("", "192.168.19.47:8443", "192.168.19.47")]
    [InlineData("", "https://192.168.19.47", "192.168.19.47")]
    [InlineData("", "192.168.19.47", "192.168.19.47")]
    public void TheGatewayIsTheRecordedOneOrTheApisAddress(string gateway, string api, string expected) =>
        Assert.Equal(
            IPAddress.Parse(expected),
            WindowsNetwork.RecordedGateway(new HostConfig { Gateway = gateway, Api = api }));

    /// <summary>
    /// A name or an IPv6 address is not a next hop, and is not guessed at.
    /// </summary>
    /// <remarks>
    /// Resolving is left to the caller, which can say what went wrong. An IPv6
    /// next hop for an IPv4 prefix is a route Windows accepts and never uses.
    /// </remarks>
    [Theory]
    [InlineData("", "")]
    [InlineData("", "incus.lan:8443")]
    [InlineData("", "[fd00::1]:8443")]
    [InlineData("fd00::1", "")]
    public void ANameOrAnIpv6AddressIsNotAGateway(string gateway, string api) =>
        Assert.Null(WindowsNetwork.RecordedGateway(new HostConfig { Gateway = gateway, Api = api }));
}
