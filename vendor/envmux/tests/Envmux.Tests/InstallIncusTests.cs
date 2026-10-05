using System.Net;

using Envmux.Commands;
using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Tests;

/// <summary>
/// The parts of attaching to an Incus that are decisions rather than calls.
/// </summary>
/// <remarks>
/// <c>envmux install</c> against a real daemon cannot be run from a test — it
/// changes somebody's Incus. What can be pinned is everything it decides on the
/// way: what to dial from what was typed, and what <c>host.json</c> becomes for
/// a network the daemon already had. The network used throughout is the real
/// one this was written against: <c>incusbr0</c> on <c>10.252.20.1/24</c>, no
/// DHCP ranges, no <c>dns.domain</c>.
/// </remarks>
public class InstallIncusTests
{
    private static IncusNetworkInfo Bridge(params (string Key, string Value)[] config) => new()
    {
        Name = "incusbr0",
        Type = "bridge",
        Description = "",
        Config = config.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal),
    };

    /// <summary>
    /// The network as the daemon has it becomes host.json, field for field.
    /// </summary>
    /// <remarks>
    /// The zone is adopted with the subnet — the bridge's dnsmasq answers only
    /// for its own domain, and unset is Incus for <c>incus</c>. No DHCP range is
    /// left as none rather than invented: pinning works around the leases then.
    /// </remarks>
    [Fact]
    public void AnAdoptedNetworkIsReadIntoHostJson()
    {
        var adopted = InstallCommand.Adopt(
            new HostConfig { Provider = HostConfig.Incus, Api = "192.168.19.43:8443" },
            Bridge(("ipv4.address", "10.252.20.1/24"), ("ipv4.nat", "true")),
            out var refusal);

        Assert.NotNull(adopted);
        Assert.Equal("", refusal);
        Assert.Equal("incusbr0", adopted.Network);
        Assert.Equal("10.252.20.1/24", adopted.Cidr);
        Assert.Equal("", adopted.DhcpRange);
        Assert.Equal("incus", adopted.DnsDomain);
        Assert.Equal(IPAddress.Parse("10.252.20.1"), adopted.BridgeAddress);

        // What it was not asked to touch, it does not.
        Assert.Equal("192.168.19.43:8443", adopted.Api);
        Assert.Empty(adopted.Problems());
    }

    /// <summary>A network that names a zone and DHCP ranges has them taken as they are.</summary>
    [Fact]
    public void AZoneAndRangesTheNetworkNamesAreTakenAsTheyAre()
    {
        var adopted = InstallCommand.Adopt(
            new HostConfig { Provider = HostConfig.Incus },
            Bridge(
                ("ipv4.address", "10.7.0.1/16"),
                ("dns.domain", "Lab."),
                ("ipv4.dhcp.ranges", "10.7.1.0-10.7.1.255, 10.7.9.0-10.7.9.255")),
            out _);

        Assert.NotNull(adopted);
        Assert.Equal("lab", adopted.DnsDomain);
        Assert.Equal("10.7.1.0-10.7.1.255, 10.7.9.0-10.7.9.255", adopted.DhcpRange);
        Assert.Empty(adopted.Problems());
    }

    /// <summary>Each network a session could not live on is refused, in words about that network.</summary>
    [Theory]
    [InlineData("ovn", "ipv4.address", "10.0.0.1/24", "bridge")]
    [InlineData("bridge", "ipv4.address", "none", "no IPv4 address")]
    [InlineData("bridge", "ipv6.address", "fd42::1/64", "no IPv4 address")]
    [InlineData("bridge", "ipv4.dhcp", "false", "ipv4.dhcp")]
    [InlineData("bridge", "dns.mode", "none", "dns.mode")]
    public void ANetworkASessionCouldNotLiveOnIsRefused(string type, string key, string value, string expected)
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { [key] = value };

        if (key is "ipv4.dhcp" or "dns.mode")
        {
            config["ipv4.address"] = "10.0.0.1/24";
        }

        var adopted = InstallCommand.Adopt(
            new HostConfig(),
            new IncusNetworkInfo { Name = "lan0", Type = type, Config = config },
            out var refusal);

        Assert.Null(adopted);
        Assert.Contains("'lan0'", refusal, StringComparison.Ordinal);
        Assert.Contains(expected, refusal, StringComparison.Ordinal);
    }

    /// <summary>
    /// What is dialled, from what somebody typed or pasted.
    /// </summary>
    /// <remarks>
    /// An <c>https://</c> URL with no port gets Incus's 8443, not a browser's
    /// 443 — that is <see cref="IncusClient.Authority"/>'s documented rule and
    /// it is kept. A path behind the host is no part of where to dial.
    /// </remarks>
    [Theory]
    [InlineData("192.168.19.43", "192.168.19.43:8443")]
    [InlineData("192.168.19.43:9443", "192.168.19.43:9443")]
    [InlineData("https://192.168.19.43", "192.168.19.43:8443")]
    [InlineData("https://192.168.19.43/", "192.168.19.43:8443")]
    [InlineData("https://prompt-app-26:8443/1.0", "prompt-app-26:8443")]
    [InlineData("  HTTPS://incus.lan:443  ", "incus.lan:443")]
    [InlineData("fd00::1", "[fd00::1]:8443")]
    public void TheAddressIsWhatWillBeDialled(string given, string expected)
    {
        Assert.Equal(expected, InstallCommand.DaemonAuthority(given, out var problem));
        Assert.Equal("", problem);
    }

    [Theory]
    [InlineData("http://192.168.19.43:8443", "https")]
    [InlineData("https://", "not an address")]
    [InlineData("two words", "not an address")]
    [InlineData("incus.lan:https", "port")]
    [InlineData("incus.lan:0", "port")]
    [InlineData("incus.lan:70000", "port")]
    public void AnAddressThatCannotBeDialledSaysWhy(string given, string expected)
    {
        Assert.Null(InstallCommand.DaemonAuthority(given, out var problem));
        Assert.Contains(expected, problem, StringComparison.Ordinal);
    }

    /// <summary>The default port is said out loud exactly when it was applied.</summary>
    [Theory]
    [InlineData("192.168.19.43", false)]
    [InlineData("https://192.168.19.43/", false)]
    [InlineData("192.168.19.43:8443", true)]
    [InlineData("https://incus.lan:443/1.0", true)]
    public void APortIsOnlyClaimedWhenOneWasGiven(string given, bool expected) =>
        Assert.Equal(expected, InstallCommand.HasPort(given));

    /// <summary>
    /// A fact about an existing daemon names the provider, so the question is not asked.
    /// </summary>
    [Theory]
    [InlineData(new[] { "--provider", "incus" }, "incus")]
    [InlineData(new[] { "--provider", "DOCKER" }, "docker")]
    [InlineData(new[] { "--provider", "HyperV" }, "hyperv")]
    [InlineData(new[] { "--provider", "libvirt" }, "libvirt")]
    [InlineData(new[] { "--token", "abc" }, "incus")]
    [InlineData(new[] { "--api", "192.168.19.43" }, "incus")]
    [InlineData(new[] { "--network", "incusbr0", "--yes" }, "incus")]
    [InlineData(new[] { "--yes", "--cidr", "10.90.0.1/24" }, null)]
    public void TheProviderIsNamedByWhatWasPassed(string[] args, string? expected) =>
        Assert.Equal(expected, InstallCommand.ProviderNamed([.. args]));

    /// <summary>
    /// The two fields an older envmux wrote are carried through an adoption untouched.
    /// </summary>
    /// <remarks>
    /// Nothing reads them, so nothing here has an opinion about them either:
    /// they are not cleared, not validated, and not moved. The file still parses
    /// with them in it, which is the whole of what they are kept for.
    /// </remarks>
    [Fact]
    public void LegacyFieldsPassThroughAnAdoptionUntouched()
    {
        var adopted = InstallCommand.Adopt(
            new HostConfig { Provider = HostConfig.Incus, Gateway = "192.168.19.43", Resolver = "10.100.0.2" },
            Bridge(("ipv4.address", "10.252.20.1/24")),
            out _);

        Assert.Equal("192.168.19.43", adopted!.Gateway);
        Assert.Equal("10.100.0.2", adopted.Resolver);
        Assert.Empty(adopted.Problems());
    }
}
