using System.Globalization;
using System.Net;
using Nics = System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text.Json;

using Envmux.Incus;

namespace Envmux.Host;

/// <summary>One of this workstation's own addresses, and how much of it is the network.</summary>
/// <remarks>
/// A value rather than a <see cref="Nics.NetworkInterface"/>, so that choosing where
/// to dial first is arithmetic on a list somebody can write down in a test.
/// </remarks>
internal readonly record struct LocalInterface(IPAddress Address, int PrefixLength)
{
    /// <summary>Whether an address is on this interface's own subnet — reachable with no router in between.</summary>
    public bool Reaches(IPAddress other) =>
        other.AddressFamily == Address.AddressFamily &&
        PrefixLength > 0 &&
        new IPNetwork(Mask(Address, PrefixLength), PrefixLength).Contains(other);

    /// <summary>Every address this machine has on an interface that is up.</summary>
    /// <remarks>
    /// Loopback and link-local are left out: nothing in a token is on the first,
    /// and the second says only that two machines share a wire, which an IPv4
    /// address on the same interface already says better.
    /// </remarks>
    public static IReadOnlyList<LocalInterface> Discover()
    {
        var found = new List<LocalInterface>();

        foreach (var nic in Nics.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != Nics.OperationalStatus.Up ||
                nic.NetworkInterfaceType == Nics.NetworkInterfaceType.Loopback)
            {
                continue;
            }

            foreach (var unicast in nic.GetIPProperties().UnicastAddresses)
            {
                if (!IPAddress.IsLoopback(unicast.Address) && !unicast.Address.IsIPv6LinkLocal)
                {
                    found.Add(new LocalInterface(unicast.Address, unicast.PrefixLength));
                }
            }
        }

        return found;
    }

    private static IPAddress Mask(IPAddress address, int prefix)
    {
        var bytes = address.GetAddressBytes();

        for (var i = 0; i < bytes.Length; i++)
        {
            var bits = Math.Clamp(prefix - (i * 8), 0, 8);
            bytes[i] &= (byte)(0xFF << (8 - bits));
        }

        return new IPAddress(bytes);
    }
}

/// <summary>Why an address is where it is in the dialling order. Lower is sooner.</summary>
internal enum CandidateKind
{
    /// <summary>IPv4, on a subnet this workstation is on. The LAN: one hop, and the address a route can name.</summary>
    OnLink,

    /// <summary>IPv4 and on-link, but over an overlay — carrier-grade NAT space, which is what mesh VPNs number from.</summary>
    Overlay,

    /// <summary>IPv4, somewhere a router would have to take us.</summary>
    Routed,

    /// <summary>IPv6, on a subnet this workstation is on.</summary>
    OnLinkV6,

    /// <summary>IPv6, anywhere else.</summary>
    RoutedV6,

    /// <summary>An address that looks like the inside of the host: a Docker or Incus bridge's own gateway.</summary>
    Bridge,
}

/// <summary>One place the daemon said it listens, and how soon to try it.</summary>
/// <param name="Authority"><c>host:port</c> exactly as the token has it, IPv6 bracketed.</param>
/// <param name="Address">The host part as an address, or null when it is a name.</param>
/// <param name="Kind">Why it sorts where it does.</param>
internal sealed record Candidate(string Authority, IPAddress? Address, CandidateKind Kind);

/// <summary>How one dial ended.</summary>
internal enum AttemptOutcome
{
    /// <summary>It presented the certificate the token names. This is the daemon.</summary>
    Matched,

    /// <summary>Something answered TLS there, and it is not the daemon that minted the token.</summary>
    WrongCertificate,

    /// <summary>The port is closed: a machine is there and nothing is listening.</summary>
    Refused,

    /// <summary>Nothing came back at all — a firewall dropping, or an address nothing has.</summary>
    TimedOut,

    /// <summary>This workstation has no way to get there.</summary>
    Unreachable,

    /// <summary>It connected and what followed was not a TLS handshake.</summary>
    Failed,

    /// <summary>Another address had already answered.</summary>
    NotNeeded,
}

/// <summary>One address, and what happened when it was dialled.</summary>
internal sealed record Attempt(Candidate Candidate, AttemptOutcome Outcome, string Detail = "");

/// <summary>Where the daemon turned out to be, and everything that was tried on the way.</summary>
/// <param name="Chosen">The address that presented the token's certificate, or null when none did.</param>
/// <param name="Attempts">Every candidate, in the order they were to be dialled.</param>
internal sealed record TrustProbeResult(Candidate? Chosen, IReadOnlyList<Attempt> Attempts)
{
    /// <summary>
    /// What was tried and how it went, as one line for a person.
    /// </summary>
    /// <remarks>
    /// The failures are the useful half. "Refused" on an overlay address and
    /// "timed out" on another is the whole story of a URL that did not work, and
    /// without it the only thing to report is that one did.
    /// </remarks>
    public string Describe() =>
        string.Join("; ", Attempts
            .Where(a => a.Outcome != AttemptOutcome.NotNeeded)
            .Select(a => $"{a.Candidate.Authority} {Phrase(a)}"));

    private static string Phrase(Attempt attempt) => attempt.Outcome switch
    {
        AttemptOutcome.Matched => "presented the token's certificate",
        AttemptOutcome.WrongCertificate => "presented a different certificate",

        // The two ways of not getting through mean different things, and the
        // second is the one with a fix on the host: an allowlist in front of
        // the API port drops rather than refuses, and the first real remote
        // had exactly that.
        AttemptOutcome.Refused => "refused the connection (nothing listening there)",
        AttemptOutcome.TimedOut => "timed out (filtered, or nothing at that address)",
        AttemptOutcome.Unreachable => "is not reachable from here",
        _ => attempt.Detail.Length > 0 ? $"failed ({attempt.Detail})" : "failed",
    };
}

/// <summary>
/// An Incus trust token, read for what it says about the daemon that minted it.
/// </summary>
/// <remarks>
/// <para>
/// <c>incus config trust add</c> prints one of these, and it is more than a
/// password. It is base64 over a JSON object carrying the daemon's certificate
/// fingerprint and every address it listens on — which is everything
/// <c>envmux install</c> otherwise has to ask a person for. With it there is no
/// <c>--api</c> to get wrong and no hex to compare: the token came from the
/// daemon's own command line, so the fingerprint inside it <em>is</em> the pin
/// decision, and an address is the right one exactly when what answers there
/// presents that certificate.
/// </para>
/// <para>
/// The secret is checked for and not kept. Nothing here needs it — the caller
/// already holds the token text it is about to send to
/// <see cref="IncusApi.AddTrustedCertificateAsync"/> — and a value that is never
/// stored cannot turn up in a log line, a debugger's view of this object, or a
/// <c>ToString</c> somebody adds to a message next year. A class rather than a
/// record for the same reason: nothing generates a printer for it.
/// </para>
/// </remarks>
internal sealed class TrustToken
{
    /// <summary>How long one address gets before it is written off as not answering.</summary>
    public static readonly TimeSpan DefaultPerAddress = TimeSpan.FromSeconds(3);

    /// <summary>How long after starting one dial the next is started.</summary>
    public static readonly TimeSpan DefaultStagger = TimeSpan.FromMilliseconds(200);

    private TrustToken(string clientName, string fingerprint, IReadOnlyList<string> addresses, DateTimeOffset? expiresAt)
    {
        ClientName = clientName;
        Fingerprint = fingerprint;
        Addresses = addresses;
        ExpiresAt = expiresAt;
    }

    /// <summary>The name the daemon's owner gave this client: what <c>incus config trust list</c> will show.</summary>
    public string ClientName { get; }

    /// <summary>The daemon's certificate fingerprint: SHA-256, lowercase hex, as <c>host.json</c> pins it.</summary>
    public string Fingerprint { get; }

    /// <summary>Everywhere the daemon said it listens, as <c>host:port</c>, in the order it said so.</summary>
    public IReadOnlyList<string> Addresses { get; }

    /// <summary>When the daemon stops honouring it, or null when it never does.</summary>
    public DateTimeOffset? ExpiresAt { get; }

    public bool IsExpired(DateTimeOffset now) => ExpiresAt is { } at && at <= now;

    /// <summary>Names it without saying anything that would let someone use it.</summary>
    public override string ToString() =>
        $"trust token for '{ClientName}' (daemon {Fingerprint[..Math.Min(12, Fingerprint.Length)]}…, " +
        $"{Addresses.Count.ToString(CultureInfo.InvariantCulture)} address(es))";

    /// <summary>
    /// Read a token, or say it is not one.
    /// </summary>
    /// <remarks>
    /// Forgiving about how it arrived — wrapped by a terminal, padded or not,
    /// either base64 alphabet — and strict about what it holds: a fingerprint
    /// that is a SHA-256, at least one address, and a secret. Something that
    /// decodes but lacks one of those is a token for something else, and the
    /// time to find that out is before dialling anything.
    /// </remarks>
    public static bool TryParse(string? text, out TrustToken token)
    {
        token = null!;

        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var compact = new string([.. text.Where(c => !char.IsWhiteSpace(c))])
            .Replace('-', '+')
            .Replace('_', '/');

        compact = compact.TrimEnd('=');
        compact = compact.PadRight(compact.Length + ((4 - (compact.Length % 4)) % 4), '=');

        try
        {
            using var document = JsonDocument.Parse(Convert.FromBase64String(compact));
            var root = document.RootElement;

            if (root.ValueKind != JsonValueKind.Object ||
                Text(root, "secret").Length == 0)
            {
                return false;
            }

            var fingerprint = IncusClient.Normalise(Text(root, "fingerprint"));

            if (fingerprint.Length != 64 || !fingerprint.All(char.IsAsciiHexDigit))
            {
                return false;
            }

            var addresses = root.TryGetProperty("addresses", out var list) && list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray()
                    .Where(a => a.ValueKind == JsonValueKind.String)
                    .Select(a => a.GetString()!.Trim())
                    .Where(a => a.Length > 0)
                    .Distinct(StringComparer.Ordinal)
                    .ToList()
                : [];

            if (addresses.Count == 0)
            {
                return false;
            }

            // Go's zero time is how Incus writes "never", and it is year one.
            DateTimeOffset? expires =
                DateTimeOffset.TryParse(
                    Text(root, "expires_at"),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal,
                    out var at) && at.Year > 1
                    ? at
                    : null;

            token = new TrustToken(Text(root, "client_name"), fingerprint, addresses, expires);
            return true;
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            return false;
        }
    }

    private static string Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    /// <summary>
    /// The token's addresses, in the order worth dialling them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A daemon listening on <c>:8443</c> lists every address the machine has,
    /// and most of them are not for us: the gateways of its Docker networks and
    /// its Incus bridge, an overlay address, IPv6 of each. Measured on the first
    /// real remote — eight addresses, one of which a workstation on the same
    /// switch could use, and the one the Operator had been given was an overlay
    /// address where 443 was refused and 8443 silently dropped.
    /// </para>
    /// <para>
    /// So: an address on a subnet this workstation is on goes first, and a plain
    /// LAN before an overlay — it is one hop, and it is also the only kind of
    /// address a Windows route can name as the next hop for the session subnet.
    /// IPv4 before IPv6, because the route and everything behind it is IPv4.
    /// Addresses that look like the inside of the host — anything in
    /// <c>172.16.0.0/12</c>, anything ending in <c>.1</c>, when it is not on a
    /// subnet of ours — are still tried, since a guess about numbering is only a
    /// guess, and tried last. Within a kind the daemon's own order stands.
    /// </para>
    /// <para>
    /// The order costs nothing to get wrong but time: which address is right is
    /// decided by the certificate, in <see cref="ProbeAsync(IReadOnlyList{Candidate}, CancellationToken)"/>.
    /// </para>
    /// </remarks>
    public IReadOnlyList<Candidate> Candidates(IEnumerable<LocalInterface> local)
    {
        var interfaces = local.ToList();

        return [.. Addresses
            .Select(authority => Classify(authority, interfaces))
            .Select((candidate, index) => (candidate, index))
            .OrderBy(c => c.candidate.Kind)
            .ThenBy(c => c.index)
            .Select(c => c.candidate)];
    }

    private static Candidate Classify(string authority, List<LocalInterface> interfaces)
    {
        // host:port, [v6]:port, or either without the port. The whole thing is
        // tried as an address first, because a bare IPv6 address is all colons
        // and none of them is in front of a port.
        var colon = authority.LastIndexOf(':');
        var host = (colon > 0 && !authority.EndsWith(']') ? authority[..colon] : authority).Trim('[', ']');

        if (!IPAddress.TryParse(authority.Trim('[', ']'), out var address) &&
            !IPAddress.TryParse(host, out address))
        {
            return new Candidate(authority, null, CandidateKind.Routed);
        }

        var onLink = interfaces.Any(i => i.Reaches(address));

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            return new Candidate(authority, address, onLink ? CandidateKind.OnLinkV6 : CandidateKind.RoutedV6);
        }

        var bytes = address.GetAddressBytes();

        if (onLink)
        {
            // 100.64.0.0/10: shared address space, and in practice a mesh VPN.
            var overlay = bytes[0] == 100 && (bytes[1] & 0xC0) == 64;
            return new Candidate(authority, address, overlay ? CandidateKind.Overlay : CandidateKind.OnLink);
        }

        var bridge = (bytes[0] == 172 && (bytes[1] & 0xF0) == 16) || bytes[3] == 1;
        return new Candidate(authority, address, bridge ? CandidateKind.Bridge : CandidateKind.Routed);
    }

    /// <summary>Find which address is the daemon, by dialling them.</summary>
    public Task<TrustProbeResult> ProbeAsync(IReadOnlyList<Candidate> candidates, CancellationToken ct) =>
        ProbeAsync(candidates, DialAsync, DefaultPerAddress, DefaultStagger, ct);

    /// <summary>
    /// Find which address is the daemon, by dialling them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Started in order, a fifth of a second apart, and not waited for in order:
    /// an address that drops packets takes its whole timeout to say nothing, and
    /// eight of those in a row is most of half a minute spent before reaching
    /// the one that answers at once. The first to present the token's
    /// certificate ends it. A better-placed address that was already being
    /// dialled gets one more stagger to answer too, so that a LAN address a few
    /// milliseconds behind an overlay one is still the one recorded.
    /// </para>
    /// <para>
    /// Nothing is sent to any of them. The dial is
    /// <see cref="IncusClient.LearnFingerprintAsync"/>, which completes a
    /// handshake, reads the certificate and hangs up — no client certificate, no
    /// request, and above all no token — so an address that turns out to be
    /// something else has learned that somebody connected.
    /// </para>
    /// </remarks>
    /// <param name="candidates">From <see cref="Candidates"/>.</param>
    /// <param name="dial">Connect to an authority and return the fingerprint it presents.</param>
    /// <param name="perAddress">How long one address gets.</param>
    /// <param name="stagger">The gap between starting one dial and the next.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<TrustProbeResult> ProbeAsync(
        IReadOnlyList<Candidate> candidates,
        Func<string, CancellationToken, Task<string>> dial,
        TimeSpan perAddress,
        TimeSpan stagger,
        CancellationToken ct)
    {
        using var all = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var dials = candidates
            .Select((candidate, index) => AttemptAsync(candidate, dial, stagger * index, perAddress, all.Token))
            .ToList();

        var pending = new List<Task<Attempt>>(dials);

        while (pending.Count > 0)
        {
            var finished = await Task.WhenAny(pending).ConfigureAwait(false);
            pending.Remove(finished);

            if ((await finished.ConfigureAwait(false)).Outcome != AttemptOutcome.Matched)
            {
                continue;
            }

            var sooner = dials.Take(dials.IndexOf(finished)).Where(d => !d.IsCompleted).ToList();

            if (sooner.Count > 0)
            {
                await Task.WhenAny(Task.WhenAll(sooner), Task.Delay(stagger, CancellationToken.None)).ConfigureAwait(false);
            }

            break;
        }

        await all.CancelAsync().ConfigureAwait(false);

        var attempts = await Task.WhenAll(dials).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();

        return new TrustProbeResult(
            attempts.FirstOrDefault(a => a.Outcome == AttemptOutcome.Matched)?.Candidate,
            attempts);
    }

    private async Task<Attempt> AttemptAsync(
        Candidate candidate,
        Func<string, CancellationToken, Task<string>> dial,
        TimeSpan delay,
        TimeSpan perAddress,
        CancellationToken all)
    {
        using var own = CancellationTokenSource.CreateLinkedTokenSource(all);

        try
        {
            await Task.Delay(delay, all).ConfigureAwait(false);
            own.CancelAfter(perAddress);

            var presented = IncusClient.Normalise(await dial(candidate.Authority, own.Token).ConfigureAwait(false));

            return presented.Equals(Fingerprint, StringComparison.Ordinal)
                ? new Attempt(candidate, AttemptOutcome.Matched)
                : new Attempt(candidate, AttemptOutcome.WrongCertificate, presented);
        }
        catch (OperationCanceledException)
        {
            // Two reasons to be cancelled, and only one of them is about this
            // address: its own clock ran out, or somebody else had answered.
            return new Attempt(candidate, all.IsCancellationRequested ? AttemptOutcome.NotNeeded : AttemptOutcome.TimedOut);
        }
        catch (SocketException e)
        {
            return new Attempt(candidate, Outcome(e.SocketErrorCode), e.SocketErrorCode.ToString());
        }
        catch (Exception e) when (e is IOException or AuthenticationException or IncusException)
        {
            return new Attempt(
                candidate,
                e.InnerException is SocketException inner ? Outcome(inner.SocketErrorCode) : AttemptOutcome.Failed,
                FirstLine(e.Message));
        }
    }

    private static AttemptOutcome Outcome(SocketError error) => error switch
    {
        SocketError.ConnectionRefused => AttemptOutcome.Refused,
        SocketError.TimedOut => AttemptOutcome.TimedOut,
        SocketError.HostUnreachable or SocketError.NetworkUnreachable or SocketError.HostNotFound
            or SocketError.AddressFamilyNotSupported or SocketError.NetworkDown => AttemptOutcome.Unreachable,
        _ => AttemptOutcome.Failed,
    };

    private static async Task<string> DialAsync(string authority, CancellationToken ct)
    {
        using var presented = await IncusClient.LearnFingerprintAsync(authority, ct).ConfigureAwait(false);
        return ClientCertificate.Fingerprint(presented);
    }

    private static string FirstLine(string text)
    {
        var end = text.IndexOfAny(['\r', '\n']);
        return (end < 0 ? text : text[..end]).Trim();
    }
}
