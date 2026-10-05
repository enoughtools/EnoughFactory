using System.Net;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The range is a build parameter, and it is copied into a disk image that is
/// then installed without a console. Everything wrong with it has to be found
/// here, because after that there is nowhere to look.
/// </summary>
[Collection(HostHome.Name)]
public class HostConfigTests
{
    [Fact]
    public void TheDefaultsAreCoherent() =>
        Assert.Empty(new HostConfig().Problems());

    [Fact]
    public void TheBridgeIsTheAddressInTheCidrAndTheRangeIsTheNetwork()
    {
        var config = new HostConfig { Cidr = "10.100.0.1/24" };

        // Two different things that a single string has to yield: the bridge's
        // own address, which is the resolver, and the network address, which is
        // what a route is written against.
        Assert.Equal(IPAddress.Parse("10.100.0.1"), config.BridgeAddress);
        Assert.Equal(IPAddress.Parse("10.100.0.0"), config.Range.BaseAddress);
        Assert.Equal(24, config.Range.PrefixLength);
    }

    [Theory]
    [InlineData("10.100.0.1", "is not an IPv4 address")]
    [InlineData("not-an-address/24", "is not an IPv4 address")]
    [InlineData("fd00::1/64", "is not an IPv4 address")]
    [InlineData("10.100.0.1/31", "too small")]
    [InlineData("10.0.0.1/4", "too big")]
    public void ABadRangeIsRefusedBeforeItReachesAnImage(string cidr, string expected)
    {
        var problems = new HostConfig { Cidr = cidr }.Problems();

        Assert.Contains(problems, p => p.Contains(expected, StringComparison.Ordinal));
    }

    [Fact]
    public void TheDhcpRangeHasToBeInsideTheCidr()
    {
        var problems = new HostConfig { Cidr = "10.100.0.1/24", DhcpRange = "10.200.0.10-10.200.0.20" }.Problems();

        Assert.Contains(problems, p => p.Contains("is not inside", StringComparison.Ordinal));
    }

    [Fact]
    public void ADhcpRangeThatStartsAfterItEndsIsCaught()
    {
        var problems = new HostConfig { DhcpRange = "10.100.0.200-10.100.0.10" }.Problems();

        Assert.Contains(problems, p => p.Contains("starts after it ends", StringComparison.Ordinal));
    }

    [Fact]
    public void ADhcpRangeWithNoHeadroomIsCaught()
    {
        // Pinned addresses live between the bridge and the DHCP range. A range
        // that starts at .1 leaves nowhere to pin, and the failure would appear
        // later as sessions that all have to be polled for an address.
        var problems = new HostConfig { DhcpRange = "10.100.0.1-10.100.0.200" }.Problems();

        Assert.Contains(problems, p => p.Contains("headroom", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("00:15:5D:E5:60")]
    [InlineData("00:15:5D:E5:60:01:02")]
    [InlineData("zz:15:5D:E5:60:01")]
    public void ABadMacIsCaught(string mac) =>
        Assert.Contains(new HostConfig { Mac = mac }.Problems(), p => p.Contains("hex octets", StringComparison.Ordinal));

    [Theory]
    [InlineData("00:15:5D:E5:60:01")]
    [InlineData("00-15-5D-E5-60-01")]
    public void EitherSpellingOfAMacIsAccepted(string mac) =>
        Assert.Empty(new HostConfig { Mac = mac }.Problems());

    [Fact]
    public void ADnsDomainHasToBeALabel() =>
        Assert.Contains(
            new HostConfig { DnsDomain = "not a label" }.Problems(),
            p => p.Contains("DNS label", StringComparison.Ordinal));

    [Fact]
    public void PinnedAddressesCountUpFromTheBridge()
    {
        var config = new HostConfig { Cidr = "10.100.0.1/24", DhcpRange = "10.100.0.10-10.100.0.200" };

        Assert.Equal(IPAddress.Parse("10.100.0.2"), config.Pinned(0));
        Assert.Equal(IPAddress.Parse("10.100.0.3"), config.Pinned(1));
    }

    [Fact]
    public void PinnedAddressesStopBelowTheDhcpRange()
    {
        // .2 through .9 with a range starting at .10 — eight of them, and the
        // ninth is refused rather than colliding with a lease.
        var config = new HostConfig { Cidr = "10.100.0.1/24", DhcpRange = "10.100.0.10-10.100.0.200" };

        Assert.Equal(8, config.PinnedCapacity);
        Assert.Equal(IPAddress.Parse("10.100.0.9"), config.Pinned(7));
        Assert.Null(config.Pinned(8));
    }

    [Fact]
    public void ANegativeIndexIsNotAnAddress() =>
        Assert.Null(new HostConfig().Pinned(-1));

    [Fact]
    public void TheNewFieldsDefaultToWhatAHostAlwaysWas()
    {
        // A host.json written before these existed says nothing about them, and
        // has to mean exactly what it meant: envmux0, and the two fields an
        // older envmux wrote empty.
        var config = new HostConfig();

        Assert.Equal("envmux0", HostConfig.DefaultNetwork);
        Assert.Equal(HostConfig.DefaultNetwork, config.Network);
        Assert.Equal("", config.Gateway);
        Assert.Equal("", config.Resolver);
        Assert.Equal(98, config.PinnedCapacity);
    }

    /// <summary>
    /// The two fields an older envmux wrote parse and mean nothing.
    /// </summary>
    /// <remarks>
    /// This workstation's live <c>host.json</c> has both, and the reader refuses
    /// an unknown key — so they have to stay readable. Nothing uses them, so a
    /// value that would once have been a problem is not one now, and a resolver
    /// is no longer kept out of the pinned band: the instance it named answers
    /// nothing anybody asks.
    /// </remarks>
    [Fact]
    public void LegacyGatewayAndResolverParseAndMeanNothing()
    {
        var config = new HostConfig { Gateway = "the-host", Resolver = "10.200.0.2" };

        Assert.Empty(config.Problems());
        Assert.Equal(IPAddress.Parse("10.100.0.2"), new HostConfig { Resolver = "10.100.0.2" }.FirstFreePinned([]));
    }

    [Fact]
    public void AnEmptyDhcpRangeIsLegalAndPinsAcrossTheWholeSubnet()
    {
        // An adopted network with no ipv4.dhcp.ranges: nothing to stay below,
        // so the band runs from above the bridge to the last host address.
        var config = new HostConfig { Provider = HostConfig.Incus, Cidr = "10.7.0.1/24", DhcpRange = "" };

        Assert.Empty(config.Problems());
        Assert.Equal(253, config.PinnedCapacity);
        Assert.Equal(IPAddress.Parse("10.7.0.2"), config.Pinned(0));
        Assert.Equal(IPAddress.Parse("10.7.0.254"), config.Pinned(252));

        // .255 is the broadcast address, and nobody's.
        Assert.Null(config.Pinned(253));
    }

    [Fact]
    public void TheCapacityOfABigSubnetIsWorkedOutRatherThanCounted()
    {
        // A /8 with no range is sixteen million addresses. Counting them one
        // Pinned() at a time was fine for ninety-eight and is not for this.
        var config = new HostConfig { Cidr = "10.0.0.1/8", DhcpRange = "" };

        Assert.Equal((1 << 24) - 3, config.PinnedCapacity);
        Assert.Equal(IPAddress.Parse("10.255.255.254"), config.Pinned(config.PinnedCapacity - 1));
    }

    [Fact]
    public void ABridgeAtTheTopOfItsSubnetLeavesNothingToPin()
    {
        // Above the bridge is the rule, and .254 has only the broadcast address
        // above it. That is DHCP for everything, not an error.
        var config = new HostConfig { Cidr = "10.7.0.254/24", DhcpRange = "" };

        Assert.Empty(config.Problems());
        Assert.Equal(0, config.PinnedCapacity);
        Assert.Null(config.Pinned(0));
        Assert.Null(config.FirstFreePinned([]));
    }

    [Fact]
    public void SeveralDhcpRangesPinBelowTheLowest()
    {
        // ipv4.dhcp.ranges is a list, and an adopted network's is read as it
        // stands rather than refused for having two.
        var config = new HostConfig { DhcpRange = "10.100.0.150-10.100.0.200, 10.100.0.50-10.100.0.99" };

        Assert.Empty(config.Problems());
        Assert.Equal(48, config.PinnedCapacity);
        Assert.Equal(IPAddress.Parse("10.100.0.49"), config.Pinned(47));
    }

    [Theory]
    [InlineData("10.100.0.100")]
    [InlineData("10.100.0.100-")]
    [InlineData("10.100.0.100-fd00::1")]
    [InlineData("10.100.0.100-10.100.0.200,")]
    public void ADhcpRangeThatIsNotOneIsStillCaught(string range)
    {
        var config = new HostConfig { DhcpRange = range };

        Assert.Contains(config.Problems(), p => p.Contains("separated by a hyphen", StringComparison.Ordinal));
        Assert.Equal(0, config.PinnedCapacity);
        Assert.Null(config.Pinned(0));
    }

    [Theory]
    [InlineData("")]
    [InlineData("a-network-name-too-long")]
    [InlineData("has space")]
    [InlineData("has/slash")]
    [InlineData("..")]
    public void ANetworkNameThatIncusWouldRefuseIsCaught(string network) =>
        Assert.Contains(
            new HostConfig { Network = network }.Problems(),
            p => p.Contains("not an Incus network name", StringComparison.Ordinal));

    [Theory]
    [InlineData("envmux0")]
    [InlineData("incusbr0")]
    [InlineData("br-lab_2.vlan")]
    public void ANetworkNameIncusWouldAcceptIsNotAProblem(string network) =>
        Assert.Empty(new HostConfig { Provider = HostConfig.Incus, Network = network }.Problems());

    [Fact]
    public void AHostEnvmuxBuiltOnlyEverHasItsOwnBridge()
    {
        // The seed creates envmux0 and nothing else, on a VM with nothing to
        // adopt. Another name under hyperv is every session attaching to a
        // network that was never made.
        Assert.Contains(
            new HostConfig { Provider = HostConfig.HyperV, Network = "incusbr0" }.Problems(),
            p => p.Contains("the seed creates envmux0", StringComparison.Ordinal));

        Assert.Empty(new HostConfig { Provider = HostConfig.HyperV }.Problems());
    }

    [Fact]
    public void TheFirstFreePinnedAddressSkipsWhatIsTaken()
    {
        var config = new HostConfig();

        Assert.Equal(IPAddress.Parse("10.100.0.2"), config.FirstFreePinned([]));
        Assert.Equal(
            IPAddress.Parse("10.100.0.4"),
            config.FirstFreePinned(["10.100.0.2", "10.100.0.3", "10.100.0.5"]));
    }

    [Fact]
    public void ALeaseTableHasThingsInItThatAreNotAddressesToAvoid()
    {
        // Both families, the odd blank, and addresses on other networks. None
        // of them is a reason to refuse, or to skip a slot.
        var config = new HostConfig();

        Assert.Equal(
            IPAddress.Parse("10.100.0.3"),
            config.FirstFreePinned(["fd42::2", "", "not an address", "192.168.1.2", "10.100.0.2"]));
    }

    [Fact]
    public void AFullBandIsNullWhichMeansDhcp()
    {
        var config = new HostConfig { DhcpRange = "10.100.0.4-10.100.0.200" };

        Assert.Equal(2, config.PinnedCapacity);
        Assert.Null(config.FirstFreePinned(["10.100.0.2", "10.100.0.3"]));
    }

    [Fact]
    public void ChoosingFromABigSubnetIsBoundedByWhatIsTaken()
    {
        // No range on a /16, and the low addresses are leases. The answer is
        // the first gap, found without walking the subnet.
        var config = new HostConfig { Cidr = "10.9.0.1/16", DhcpRange = "" };
        var taken = Enumerable.Range(2, 300).Select(i => $"10.9.{i / 256}.{i % 256}");

        Assert.Equal(IPAddress.Parse("10.9.1.46"), config.FirstFreePinned(taken));
    }

    [Fact]
    public void TheDefaultProviderIsHyperV()
    {
        Assert.Equal(HostConfig.HyperV, new HostConfig().Provider);
        Assert.True(new HostConfig().IsHyperV);
        Assert.False(new HostConfig { Provider = HostConfig.Incus }.IsHyperV);
    }

    [Fact]
    public void AnUnknownProviderIsAProblem()
    {
        Assert.Contains(
            new HostConfig { Provider = "libvirt" }.Problems(),
            p => p.Contains("provider", StringComparison.Ordinal));

        Assert.Empty(new HostConfig { Provider = HostConfig.Incus }.Problems());
        Assert.Empty(new HostConfig { Provider = HostConfig.HyperV }.Problems());
    }

    [Fact]
    public void UnderTheIncusProviderTheHyperVFieldsAreNotChecked()
    {
        // The MAC is Hyper-V's; a host pointed at an existing daemon has no VM,
        // so a placeholder there is not a problem to report.
        Assert.Empty(new HostConfig { Provider = HostConfig.Incus, Mac = "not-a-mac" }.Problems());
        Assert.Contains(
            new HostConfig { Provider = HostConfig.HyperV, Mac = "not-a-mac" }.Problems(),
            p => p.Contains("mac", StringComparison.Ordinal));
    }

    [Fact]
    public void ThereIsNothingToTalkToUntilThereIsAFingerprint()
    {
        // A configured address with no pinned fingerprint is a host that cannot
        // be authenticated, and the client refuses rather than trusting it.
        Assert.False(new HostConfig { Api = "10.0.0.5:8443" }.IsProvisioned);
        Assert.False(new HostConfig { Fingerprint = "abc" }.IsProvisioned);
    }

    [Fact]
    public void RoundTripsThroughItsOwnFile()
    {
        var home = Directory.CreateTempSubdirectory("envmux-host");

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home.FullName);

            var written = new HostConfig
            {
                Cidr = "10.42.0.1/24",
                DhcpRange = "10.42.0.20-10.42.0.99",
                DnsDomain = "lab",
                Api = "10.0.0.5:8443",
                Fingerprint = "deadbeef",
                Provider = HostConfig.Incus,
                Network = "incusbr0",
                Gateway = "192.168.19.43",
                Resolver = "10.42.0.2",
            };

            written.Save();

            Assert.Equal(written, HostConfig.Load());

            // Under the names the file is documented with. The reader refuses
            // a key it does not know, so a misspelt property would not be a
            // field quietly dropped — it would be a host.json that cannot be
            // read back at all. gateway and resolver are the names an older
            // envmux wrote, and a file carrying them has to read back.
            var text = File.ReadAllText(HostConfig.Location);
            Assert.Contains("\"network\": \"incusbr0\"", text, StringComparison.Ordinal);
            Assert.Contains("\"gateway\": \"192.168.19.43\"", text, StringComparison.Ordinal);
            Assert.Contains("\"resolver\": \"10.42.0.2\"", text, StringComparison.Ordinal);

            // And only what was set: the derived ones are not part of the file.
            Assert.DoesNotContain("bridgeAddress", text, StringComparison.Ordinal);
            Assert.DoesNotContain("pinnedCapacity", text, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
            home.Delete(recursive: true);
        }
    }

    [Fact]
    public void AFileFromBeforeTheNetworkWasAFieldStillLoads()
    {
        var home = Directory.CreateTempSubdirectory("envmux-host");

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home.FullName);

            File.WriteAllText(
                HostConfig.Location,
                """
                {
                  "cidr": "10.100.0.1/24",
                  "dhcpRange": "10.100.0.100-10.100.0.200",
                  "dnsDomain": "envmux",
                  "api": "192.168.19.47:8443",
                  "fingerprint": "deadbeef",
                  "provider": "hyperv"
                }
                """);

            var config = HostConfig.Load();

            Assert.Equal(HostConfig.DefaultNetwork, config.Network);
            Assert.Equal("", config.Gateway);
            Assert.Equal("", config.Resolver);
            Assert.Empty(config.Problems());
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
            home.Delete(recursive: true);
        }
    }

    [Fact]
    public void AMissingFileIsTheDefaultsRatherThanAnError()
    {
        var home = Path.Combine(Path.GetTempPath(), "envmux-host-" + Guid.NewGuid().ToString("N"));

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home);
            Assert.Equal(new HostConfig(), HostConfig.Load());
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
        }
    }
}
