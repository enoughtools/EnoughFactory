using System.Globalization;
using System.Net;
using System.Net.Sockets;

using Envmux.Incus;

namespace Envmux.Portal;

/// <summary>
/// How an instance reaches this process's API: a second listener on the
/// workstation, and a proxy device that makes it loopback inside.
/// </summary>
/// <remarks>
/// <para>
/// The portal is on <c>127.0.0.1</c> and nothing else, for good reason — it can
/// open a shell in the instance. But the instance has to talk to envmux too,
/// to carry the room, and a container behind the Incus host's bridge cannot
/// reach the workstation's loopback. So the same Kestrel binds a second
/// endpoint, on the one interface that faces the Hyper-V switch the host is on,
/// serving only the chat API and refusing everything else — and the instance
/// is given an Incus <em>proxy device</em>: incusd listens on
/// <c>127.0.0.1:8078</c> inside the container and dials the workstation on its
/// behalf. Inside, the API is a fixed loopback URL; nothing in the guest is
/// told an address, and the device is rewritten every session, so the
/// workstation's DHCP lease can move without the guest knowing.
/// </para>
/// <para>
/// <b>The device grants no identity.</b> Measured in <c>docs/live-volumes.md</c>
/// §3.1: a connection through the proxy arrives from the host VM's address,
/// and so does a direct connection from any instance on that bridge. The
/// listener cannot tell one instance from another and does not try — every
/// request is authorised by the session's own token, sent as a bearer. The
/// device is ergonomics; the token is the whole of the security.
/// </para>
/// <para>
/// <b>Which interface.</b> Found the way a route is found: open a UDP socket
/// "towards" the Incus API address in <c>host.json</c> and read back the local
/// endpoint the kernel chose. Nothing is sent. Not <c>0.0.0.0</c>: this
/// endpoint takes the credential the workstation signs into the session with,
/// and has no business answering on a café network.
/// </para>
/// </remarks>
internal static class ApiBridge
{
    /// <summary>The port the API is on inside every instance. Fixed, so nothing in the guest has to be told.</summary>
    public const int InsidePort = 8078;

    /// <summary>Where a process in the instance finds the API.</summary>
    public static readonly string InsideUrl = $"http://127.0.0.1:{InsidePort.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>The variable carrying <see cref="InsideUrl"/> into a task's environment.</summary>
    public const string UrlVariable = "ENVMUX_API_URL";

    /// <summary>
    /// The variable carrying the session's token into a task's environment.
    /// </summary>
    /// <remarks>
    /// The environment of the exec, and nowhere else. Not <c>/etc/profile.d</c>,
    /// where the rest of the session's environment goes, and not any file in the
    /// instance: the portal promises the token is never written down, and that
    /// promise does not stop at the machine boundary.
    /// </remarks>
    public const string TokenVariable = "ENVMUX_API_TOKEN";

    /// <summary>The proxy device's name on the instance, so a stale one is overwritten rather than joined.</summary>
    public const string DeviceName = "envmux-api";

    /// <summary>
    /// The address on this machine the Incus host would answer back to.
    /// </summary>
    /// <returns>Null when there is no host configured, or no route to it.</returns>
    public static IPAddress? FacingAddress(string api)
    {
        if (string.IsNullOrWhiteSpace(api))
        {
            return null;
        }

        var authority = IncusClient.Authority(api);
        var host = authority[..authority.LastIndexOf(':')].Trim('[', ']');

        if (!IPAddress.TryParse(host, out var target))
        {
            // A hostname rather than an address. Resolving it here would be a
            // DNS lookup on every session start for a file that is written once;
            // host.json carries addresses, and this says so if it ever does not.
            return null;
        }

        try
        {
            using var probe = new Socket(target.AddressFamily, SocketType.Dgram, ProtocolType.Udp);

            // Connecting a UDP socket sends nothing. It asks the kernel which
            // local address a packet to the target would leave from, which is
            // the interface the host's answer would come back on.
            probe.Connect(target, 65530);

            return probe.LocalEndPoint is IPEndPoint local && !IPAddress.IsLoopback(local.Address)
                ? local.Address
                : null;
        }
        catch (SocketException)
        {
            return null;
        }
    }

    /// <summary>The proxy device: listen on loopback inside, connect to the workstation outside.</summary>
    public static Dictionary<string, string> Device(IPEndPoint bridge) =>
        new(StringComparer.Ordinal)
        {
            ["type"] = "proxy",
            ["bind"] = "instance",
            ["listen"] = $"tcp:127.0.0.1:{InsidePort.ToString(CultureInfo.InvariantCulture)}",
            ["connect"] = $"tcp:{bridge.Address}:{bridge.Port.ToString(CultureInfo.InvariantCulture)}",
        };

    /// <summary>The two variables a task in the instance needs to call the API.</summary>
    public static IEnumerable<KeyValuePair<string, string>> Environment(string token)
    {
        yield return new KeyValuePair<string, string>(UrlVariable, InsideUrl);
        yield return new KeyValuePair<string, string>(TokenVariable, token);
    }
}
