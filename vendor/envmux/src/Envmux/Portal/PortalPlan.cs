using Envmux.Config;
using Envmux.Session;

namespace Envmux.Portal;

/// <summary>
/// What the portal is going to be, before there is a listener to serve it on.
/// </summary>
/// <remarks>
/// Resolved with the rest of the session so that <c>--dry-run</c> can print the
/// URL and the token without starting anything, and so that nothing downstream
/// has to re-decide what an absent <c>portal</c> block meant.
/// </remarks>
internal sealed record PortalPlan
{
    /// <summary>Whether it is served at all.</summary>
    public required bool Enabled { get; init; }

    /// <summary>Whether starting the session opens a browser at it.</summary>
    public required bool OpenOnStart { get; init; }

    /// <summary>
    /// The token that gets you in, or empty when the portal wants none.
    /// </summary>
    /// <remarks>
    /// Generated per session and never written down. It dies with the process,
    /// which means a URL bookmarked today is a URL that asks for a new token
    /// tomorrow — deliberate, and the reason the window prints the whole link.
    /// </remarks>
    public required string Token { get; init; }

    /// <summary>Chat-only bearer for guests; the browser control token never enters them.</summary>
    public string RoomToken { get; init; } = Generated.Token(24);

    /// <summary>
    /// Where the portal answers, and the only address it ever has.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Loopback, and nothing else. It used to have a hostname of its own in the
    /// routing scheme, because the routes and the page arrived on the same
    /// listener and had to be told apart by <c>Host</c>. There is no shared
    /// listener now — a route is a port on the instance's own address — so the
    /// portal is simply a page this process serves about the session, on the
    /// machine that is running it.
    /// </para>
    /// <para>
    /// Which is also the right security boundary. It can open a shell in the
    /// instance, so it should be reachable from exactly one machine: this one.
    /// </para>
    /// </remarks>
    public const string Loopback = "127.0.0.1";

    /// <summary>Whether a request has to prove anything before it is answered.</summary>
    public bool WantsToken => Token.Length > 0;

    /// <summary>The URL, with the token on it if there is one.</summary>
    public string Url(int port) =>
        WantsToken ? $"http://{Loopback}:{port}/?k={Token}" : $"http://{Loopback}:{port}/";

    public static PortalPlan Resolve(PortalConfig? config)
    {
        var enabled = config?.Enabled ?? PortalConfig.DefaultEnabled;
        var wantsToken = config?.Token ?? PortalConfig.DefaultToken;

        return new PortalPlan
        {
            Enabled = enabled,
            OpenOnStart = config?.Open ?? PortalConfig.DefaultOpen,

            // Not minted at all when it is not wanted, so there is no secret in
            // memory that nothing checks — and none when the portal is off.
            Token = enabled && wantsToken ? Generated.Token(TokenLength) : "",
        };
    }

    /// <summary>
    /// How long the token is.
    /// </summary>
    /// <remarks>
    /// Shorter than the 48 characters <c>generate</c> mints, because this one is
    /// read off a terminal and occasionally typed. Twenty-four characters of the
    /// URL-safe alphabet is around 143 bits, against an attacker who has to be
    /// on this machine already.
    /// </remarks>
    private const int TokenLength = 24;
}
