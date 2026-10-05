namespace Envmux.Config;

/// <summary>
/// The session's browser: a SOCKS5 port on this machine's loopback, and a
/// browser envmux launches on it, in which <c>localhost</c> is the instance.
/// </summary>
/// <remarks>
/// <para>
/// Nothing on this machine resolves or routes to an instance: the zone, its
/// route and its certificates are in <c>archive/zone</c>. A browser whose
/// loopback <em>is</em> the instance needs none of that, reaches a server bound
/// to the instance's own <c>127.0.0.1</c> — where most dev servers bind unless
/// told otherwise — and <c>localhost</c> is a secure context by origin, so no
/// certificate is needed either.
/// </para>
/// <para>
/// The listener lives in this process, next to the portal, and goes when it
/// does. It is not a daemon and it is not in the routes' path. What it carries
/// into the instance travels over an Incus exec, which is the channel envmux
/// already has; see <see cref="Socks.InstanceRelay"/>.
/// </para>
/// </remarks>
internal sealed record BrowserConfig
{
    /// <summary>Whether the session claims a proxy port at all.</summary>
    public bool? Enabled { get; init; }

    /// <summary>
    /// Where traffic that is not for the instance's loopback leaves from:
    /// <c>"local"</c> or <c>"instance"</c>.
    /// </summary>
    /// <remarks>
    /// <c>local</c> by default, because an app is more than its own origin: a
    /// map, a font, a sign-in page and an analytics script all come from
    /// somewhere else, and they should behave the way they do in the browser the
    /// developer already uses — from this machine's network, with this machine's
    /// DNS. <c>instance</c> sends everything through the box instead, for an app
    /// that names things only the instance can resolve, or that must be seen
    /// coming from the instance's address.
    /// </remarks>
    public string? Egress { get; init; }

    /// <summary>
    /// The loopback port to claim, or the range to claim within, in the shape
    /// <c>port</c> takes.
    /// </summary>
    public PortSpec? Port { get; init; }

    /// <summary>
    /// Which browser the key launches: <c>"chrome"</c>, <c>"firefox"</c>,
    /// <c>"edge"</c>, or a path to one of them. The first found, in that order,
    /// when absent.
    /// </summary>
    public string? Use { get; init; }

    /// <summary>
    /// Where the browser opens: a route's name, or a URL. The first web route,
    /// by name, when absent.
    /// </summary>
    public string? Open { get; init; }

    /// <summary>
    /// The browser's colour, as <c>#rrggbb</c>. Picked from the session's name
    /// when absent, so each session is its own colour and keeps it.
    /// </summary>
    public string? Color { get; init; }

    public const bool DefaultEnabled = true;
    public const string EgressLocal = "local";
    public const string EgressInstance = "instance";

    /// <summary>SOCKS' own port, which is also where a session starts looking.</summary>
    public const int DefaultPort = 1080;
}
