using System.Net;
using System.Net.Sockets;

namespace Envmux.Routing;

/// <summary>
/// Finds the loopback port a session will claim.
/// </summary>
/// <remarks>
/// <para>
/// The claim is a held socket. There is no lockfile, no registry, and no daemon
/// handing out leases, which means there is no such thing as a stale claim: a
/// session that died released its port when its process did.
/// </para>
/// <para>
/// This type only <em>probes</em>. The real claim is Kestrel's own bind, which
/// walks the same candidates — probing and then handing the port to someone else
/// to bind would leave a window for another process to take it in between.
/// </para>
/// </remarks>
internal static class PortFinder
{
    /// <summary>How far up from a bare preferred port to keep trying.</summary>
    public const int Attempts = Config.PortSpec.DefaultWalk;

    /// <summary>
    /// The ports to try, in order, starting at <paramref name="preferred"/>.
    /// Stops at 65535 rather than wrapping.
    /// </summary>
    public static IEnumerable<int> Candidates(int preferred) =>
        Config.PortSpec.Single(preferred).Candidates();

    /// <summary>
    /// Whether a port is bindable on loopback right now.
    /// </summary>
    /// <remarks>
    /// Only honest for as long as it takes to return — use it to report, not to
    /// reserve.
    /// </remarks>
    public static bool IsFree(int port)
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            socket.Bind(new IPEndPoint(IPAddress.Loopback, port));
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    /// <summary>
    /// The first candidate that looks free, or <c>null</c> if every one of them
    /// is taken.
    /// </summary>
    public static int? FirstFree(int preferred) =>
        Candidates(preferred).Cast<int?>().FirstOrDefault(p => IsFree(p!.Value));

    /// <summary>The first free port in a declared range, for reporting.</summary>
    public static int? FirstFree(Config.PortSpec spec) =>
        spec.Candidates().Cast<int?>().FirstOrDefault(p => IsFree(p!.Value));
}
