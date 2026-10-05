using Envmux.Config;
using Envmux.Session;

namespace Envmux.Socks;

/// <summary>Where a connection that is not for the instance's loopback is dialled from.</summary>
internal enum Egress
{
    /// <summary>From this machine, with its DNS: the web behaves as it does in any other browser.</summary>
    Local,

    /// <summary>From inside the instance, with its DNS: the browser sees the box's network.</summary>
    Instance,
}

/// <summary>
/// What the session's SOCKS port is going to be, before anything listens.
/// </summary>
/// <remarks>
/// Resolved with the rest of the plan for the same reasons <see cref="Portal.PortalPlan"/>
/// is: <c>--dry-run</c> can say what will happen, and nothing downstream has to
/// re-decide what an absent block meant.
/// </remarks>
internal sealed record SocksPlan
{
    public required bool Enabled { get; init; }

    public required Egress Egress { get; init; }

    public required PortSpec Port { get; init; }

    /// <summary>The browser asked for by name or path, or null for the first found.</summary>
    public string? Use { get; init; }

    /// <summary>A route name or a URL to open at, or null for the first web route.</summary>
    public string? Open { get; init; }

    /// <summary>
    /// The domain the session's instance and services are named under inside
    /// the host, whose names are dialled from inside the instance.
    /// </summary>
    public string Domain { get; init; } = "";

    /// <summary>The colour the browser's profile starts as: opaque ARGB.</summary>
    public required uint Colour { get; init; }

    /// <summary>
    /// The SOCKS username, which is the session's instance name.
    /// </summary>
    /// <remarks>
    /// A name rather than a secret: the port already says which session this
    /// is, and the name is what makes a credential pasted into a tool readable
    /// as the session it is for.
    /// </remarks>
    public required string User { get; init; }

    /// <summary>
    /// The SOCKS password, minted per run and never written down.
    /// </summary>
    /// <remarks>
    /// For whatever can send one — curl, a script, a browser configured by hand.
    /// Chrome cannot (crbug 40323993), which is why a browser envmux launched is
    /// let in by who it is instead; see <see cref="SocksListener"/>.
    /// </remarks>
    public required string Password { get; init; }

    /// <summary>The proxy as a URL a tool that speaks SOCKS5 with credentials accepts.</summary>
    public string Url(int port) =>
        $"socks5h://{User}:{Password}@{Portal.PortalPlan.Loopback}:{port.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <exception cref="ConfigException">An egress that is neither local nor instance, or a port out of range.</exception>
    public static SocksPlan Resolve(BrowserConfig? config, string instanceName)
    {
        var egress = config?.Egress?.Trim().ToLowerInvariant() switch
        {
            null or "" or BrowserConfig.EgressLocal => Egress.Local,
            BrowserConfig.EgressInstance => Egress.Instance,
            var other => throw new ConfigException(
                $"'browser.egress' is '{other}' — it is \"{BrowserConfig.EgressLocal}\" or \"{BrowserConfig.EgressInstance}\""),
        };

        var port = config?.Port ?? PortSpec.Single(BrowserConfig.DefaultPort);
        port.Validate();

        var enabled = config?.Enabled ?? BrowserConfig.DefaultEnabled;

        return new SocksPlan
        {
            Enabled = enabled,
            Egress = egress,
            Port = port,
            Use = string.IsNullOrWhiteSpace(config?.Use) ? null : config.Use.Trim(),
            Open = string.IsNullOrWhiteSpace(config?.Open) ? null : config.Open.Trim(),
            Colour = config?.Color is { Length: > 0 } color
                ? BrowserLaunch.ParseColour(color.Trim())
                  ?? throw new ConfigException($"'browser.color' is '{color}' — write it as #rrggbb, like #00897b")
                : BrowserLaunch.ColourFor(instanceName),
            User = instanceName,

            // Not minted when nothing will check it.
            Password = enabled ? Generated.Token(PasswordLength) : "",
        };
    }

    /// <summary>
    /// The password's length: the portal token's, for the portal token's reason
    /// — it is read off a terminal and occasionally typed.
    /// </summary>
    private const int PasswordLength = 24;
}
