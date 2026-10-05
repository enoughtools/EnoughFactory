using System.Globalization;
using System.Net;
using System.Text.Json;

namespace Envmux.Host.Windows;

/// <summary>What an older envmux left in Windows: a route for the range, a resolver policy for the zone.</summary>
/// <param name="Route">The persistent route's next hop, or null when there is no route for the prefix.</param>
/// <param name="Nrpt">The rule's name servers, joined with commas, or null when there is no rule for the zone.</param>
internal sealed record WiringStatus(string? Route, string? Nrpt)
{
    /// <summary>Whether either half is still there.</summary>
    public bool Any => Route is not null || Nrpt is not null;
}

/// <summary>
/// The range this workstation has spare, and the wiring an older envmux put in.
/// </summary>
/// <remarks>
/// <para>
/// envmux used to tell Windows two things per workstation: a static route
/// sending the range to the machine Incus runs on, and an NRPT rule sending
/// <c>*.envmux</c> to whatever answered the zone. Neither exists any more. A
/// session is reached through the browser its process launches — whose
/// <c>localhost</c> is the instance, over an exec relay — and its ssh alias
/// goes through the same relay, so nothing on the workstation routes to the
/// range or resolves the zone. The code that decided, wrote and diagnosed that
/// wiring is under <c>archive/zone/</c>.
/// </para>
/// <para>
/// What is left is the other direction. A workstation that ran the older
/// version still has the route and the rule — persistent, both of them — and
/// <c>envmux host unwire</c> takes them off. And choosing a range for a new
/// <c>envmux0</c> still asks what this machine already routes, not because the
/// workstation will route to it but because a range that collides with a VPN's
/// is a bridge whose instances cannot reach that VPN's addresses.
/// </para>
/// </remarks>
internal static class WindowsNetwork
{
    /// <summary>The zone as NRPT wants it written: a leading dot means "and everything under it".</summary>
    public static string Namespace(HostConfig config) => "." + config.DnsDomain.Trim('.').ToLowerInvariant();

    /// <summary>The range as a route destination — the network address, not the bridge's.</summary>
    public static string DestinationPrefix(HostConfig config)
    {
        var range = config.Range;
        return $"{range.BaseAddress}/{range.PrefixLength}";
    }

    /// <summary>The network address on its own, for a tool that wants it that way.</summary>
    public static string Destination(HostConfig config) => config.Range.BaseAddress.ToString();

    /// <summary>
    /// The prefix length written out as a dotted mask.
    /// </summary>
    /// <remarks>
    /// Only for <c>route.exe</c>, which predates CIDR notation and will not take
    /// it. Everything else in here uses the prefix.
    /// </remarks>
    public static string Mask(HostConfig config)
    {
        var bits = config.Range.PrefixLength;
        var mask = bits == 0 ? 0u : uint.MaxValue << (32 - bits);

        return new IPAddress(BitConverter.GetBytes(System.Buffers.Binary.BinaryPrimitives.ReverseEndianness(mask)))
            .ToString();
    }

    /// <summary>What an older envmux's wiring left in place, if anything.</summary>
    public static async Task<WiringStatus> StatusAsync(HostConfig config, CancellationToken ct = default)
    {
        if (!Powershell.IsAvailable)
        {
            return new WiringStatus(null, null);
        }

        var json = await Powershell.JsonAsync(
            """
            $route = Get-NetRoute -DestinationPrefix $Prefix -ErrorAction SilentlyContinue |
                     Select-Object -First 1
            $rule  = Get-DnsClientNrptRule -ErrorAction SilentlyContinue |
                     Where-Object { $_.Namespace -contains $Zone } | Select-Object -First 1

            [pscustomobject]@{
              route = if ($route) { [string]$route.NextHop } else { $null }
              nrpt  = if ($rule)  { ($rule.NameServers -join ',') } else { $null }
            } | ConvertTo-Json -Compress
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Prefix"] = DestinationPrefix(config),
                ["Zone"] = Namespace(config),
            },
            ct).ConfigureAwait(false);

        if (json.ValueKind != JsonValueKind.Object)
        {
            return new WiringStatus(null, null);
        }

        return new WiringStatus(Text(json, "route"), Text(json, "nrpt"));
    }

    /// <summary>
    /// Take an older envmux's route and rule back off.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Found by prefix and by zone, from <c>host.json</c>, because that is how
    /// they were written: the version that wired them derived both from the
    /// same file. Nothing current writes either, so whatever is there for this
    /// range and this zone is that version's — there is no other envmux host's
    /// wiring to mistake it for, which is why this no longer compares next hops
    /// or asks for <c>--force</c>.
    /// </para>
    /// <para>
    /// Nothing there is nothing to do, and is said rather than elevated for:
    /// the check needs no Administrator prompt and most workstations from here
    /// on will never have had the wiring.
    /// </para>
    /// </remarks>
    /// <param name="config">The range and the zone the old wiring was written for.</param>
    /// <param name="report">Told each thing that was done.</param>
    /// <param name="ct">Cancels the wait on PowerShell.</param>
    /// <returns>True when something was removed; false when there was nothing to remove.</returns>
    public static async Task<bool> UnwireAsync(
        HostConfig config,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        var current = await StatusAsync(config, ct).ConfigureAwait(false);

        if (!current.Any)
        {
            return false;
        }

        if (!await Powershell.IsElevatedAsync(ct).ConfigureAwait(false))
        {
            throw new PowershellException(
                $"removing the route for {DestinationPrefix(config)} and the NRPT rule for {Namespace(config)} " +
                "needs an elevated prompt. Run this from an Administrator terminal.");
        }

        await Powershell.CheckedAsync(
            """
            foreach ($store in @('ActiveStore', 'PersistentStore')) {
              Remove-NetRoute -DestinationPrefix $Prefix -PolicyStore $store `
                              -Confirm:$false -ErrorAction SilentlyContinue
            }

            # The persistent half was written by route.exe, because the cmdlet
            # could not write it on the Windows this was built on, so it comes
            # back out the same way.
            & route.exe delete $Destination mask $Mask | Out-Null

            Get-DnsClientNrptRule -ErrorAction SilentlyContinue |
              Where-Object { $_.Namespace -contains $Zone } |
              ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Prefix"] = DestinationPrefix(config),
                ["Destination"] = Destination(config),
                ["Mask"] = Mask(config),
                ["Zone"] = Namespace(config),
            },
            ct).ConfigureAwait(false);

        if (current.Route is not null)
        {
            report?.Invoke($"route {DestinationPrefix(config)} → {current.Route} removed");
        }

        if (current.Nrpt is not null)
        {
            report?.Invoke($"nrpt  {Namespace(config)} → {current.Nrpt} removed");
        }

        return true;
    }

    /// <summary>
    /// A range this workstation is not already using.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The default is <c>10.100.0.0/24</c> and it is usually free. The
    /// workstation no longer routes to the range, so a collision here is not
    /// the blackhole it used to be — but an instance on a bridge whose range is
    /// also a VPN's cannot reach that VPN's addresses, and a corporate LAN on
    /// <c>10.100.0.0/16</c> is common enough that offering the default blind
    /// would set that trap for somebody.
    /// </para>
    /// <para>
    /// So this asks Windows what it already routes and offers the first
    /// <c>10.x.0.0/24</c> that nothing overlaps. A suggestion, not a decision:
    /// the wizard shows it and takes an answer.
    /// </para>
    /// </remarks>
    private static readonly int[] Preferred = [100];

    public static async Task<string> SuggestCidrAsync(CancellationToken ct = default)
    {
        var taken = await RoutedPrefixesAsync(ct).ConfigureAwait(false);

        // 100 first, because it is the documented default and a machine where it
        // is free should end up with the range every other page describes.
        foreach (var second in Preferred.Concat(Enumerable.Range(90, 60)))
        {
            var candidate = $"10.{second.ToString(CultureInfo.InvariantCulture)}.0";

            if (!taken.Any(prefix => Overlaps(prefix, candidate)))
            {
                return $"{candidate}.1/24";
            }
        }

        return HostConfig.DefaultCidr;
    }

    /// <summary>The IPv4 prefixes this machine already has a route for.</summary>
    private static async Task<IReadOnlyList<string>> RoutedPrefixesAsync(CancellationToken ct)
    {
        if (!Powershell.IsAvailable)
        {
            return [];
        }

        var result = await Powershell.RunAsync(
            """
            @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
              Where-Object { $_.DestinationPrefix -ne '0.0.0.0/0' } |
              ForEach-Object { $_.DestinationPrefix }) -join "`n"
            """,
            ct: ct).ConfigureAwait(false);

        return result.Ok
            ? [.. result.Output
                .ReplaceLineEndings("\n")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)]
            : [];
    }

    /// <summary>
    /// Whether an existing route covers a candidate /24.
    /// </summary>
    /// <remarks>
    /// Compared on the first three octets rather than by arithmetic. A route of
    /// <c>10.100.0.0/16</c> covers <c>10.100.0.0/24</c> and a route of
    /// <c>10.100.5.0/24</c> does not, and the cheap test that gets both right is
    /// whether either is a prefix of the other.
    /// </remarks>
    internal static bool Overlaps(string routed, string candidate)
    {
        var network = routed.Split('/')[0];
        var octets = network.Split('.');

        if (octets.Length != 4)
        {
            return false;
        }

        var prefix = int.TryParse(routed.Split('/').ElementAtOrDefault(1),
            NumberStyles.Integer, CultureInfo.InvariantCulture, out var bits)
            ? bits
            : 32;

        // Only the first two octets are compared for anything wider than a /24,
        // which is what makes a /16 count as covering the whole of 10.x.
        var significant = prefix <= 16 ? 2 : 3;

        return string.Join('.', octets.Take(significant))
            .Equals(string.Join('.', candidate.Split('.').Take(significant)), StringComparison.Ordinal);
    }

    /// <summary>The DHCP range that goes with a bridge address, with headroom below it.</summary>
    /// <remarks>
    /// <c>.100</c> to <c>.200</c>, matching <see cref="HostConfig.DefaultDhcpRange"/>:
    /// everything below it is pinnable, and pinning is the normal path rather
    /// than the exception.
    /// </remarks>
    public static string DhcpFor(string cidr)
    {
        var octets = cidr.Split('/')[0].Split('.');

        if (octets.Length != 4)
        {
            return HostConfig.DefaultDhcpRange;
        }

        var network = string.Join('.', octets.Take(3));
        return $"{network}.100-{network}.200";
    }

    private static string? Text(JsonElement json, string name) =>
        json.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
