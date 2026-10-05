namespace Envmux.Config;

/// <summary>
/// The portal: the session in a browser tab, served by the listener the routes
/// already arrive on.
/// </summary>
/// <remarks>
/// <para>
/// On by default, because the port is claimed either way and a session that
/// cannot be looked at from the machine it is running on was only ever a
/// terminal away from being one that can. It costs no process, no port and no
/// container — it is a handful of endpoints on the router that is already
/// there.
/// </para>
/// <para>
/// Reachable from 127.0.0.1 and nowhere else, because that is where the
/// listener is bound. That is a property of the whole design rather than a
/// setting here: one port, on loopback, is the claim. What this block decides
/// is whether the portal answers on it at all, whether it wants a token first,
/// and whether starting a session opens a browser at it.
/// </para>
/// </remarks>
internal sealed record PortalConfig
{
    /// <summary>Whether the portal answers at all.</summary>
    public bool? Enabled { get; init; }

    /// <summary>
    /// Whether a token is needed to reach it.
    /// </summary>
    /// <remarks>
    /// On by default. Loopback is not a boundary between you and everything
    /// else on this machine — every other process on the host, and anything in
    /// a container with host networking, can reach a bound loopback port too,
    /// and this one hands out a shell in your container. The token is generated
    /// per session, printed in the window, and carried in the URL once.
    /// </remarks>
    public bool? Token { get; init; }

    /// <summary>Whether starting a session opens a browser at the portal.</summary>
    public bool? Open { get; init; }

    public const bool DefaultEnabled = true;
    public const bool DefaultToken = true;
    public const bool DefaultOpen = false;
}
