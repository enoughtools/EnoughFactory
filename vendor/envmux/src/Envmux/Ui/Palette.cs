namespace Envmux.Ui;

/// <summary>
/// The look: DOS chrome lit in neon. 1985 imagining 2050.
/// </summary>
/// <remarks>
/// <para>
/// Colours are declared once here so the whole surface stays coherent — a TUI
/// that reaches for a different magenta in every pane reads as a mess rather
/// than a style. Everything is 24-bit RGB; terminals that cannot manage it
/// degrade to their nearest palette entry, which still looks deliberate because
/// the hues are far apart.
/// </para>
/// <para>
/// Carried across three rewrites now — Ratatui, then Terminal.Gui, then
/// Consolonia, now escape sequences written by hand. The toolkit keeps
/// changing; the palette does not, because it is the one part of this UI
/// nobody has ever wanted to redo.
/// </para>
/// </remarks>
internal static class Palette
{
    /// <summary>The void behind everything.</summary>
    public static readonly Rgb Void = new(0x0a, 0x01, 0x18);

    /// <summary>
    /// The desktop the panels sit on.
    /// </summary>
    /// <remarks>
    /// A shade off <see cref="Void"/> rather than equal to it. DOS put its
    /// windows on a patterned desktop, and the whole look collapses if the thing
    /// behind the panels is the same colour as the inside of them.
    /// </remarks>
    public static readonly Rgb Desktop = new(0x14, 0x06, 0x28);

    /// <summary>The primary accent. Chrome, selection, and the wordmark.</summary>
    public static readonly Rgb Neon = new(0xff, 0x2b, 0xd6);

    /// <summary>The secondary accent, for data the eye should land on.</summary>
    public static readonly Rgb Cyan = new(0x00, 0xf0, 0xff);

    /// <summary>Healthy, ready, connected.</summary>
    public static readonly Rgb Acid = new(0x39, 0xff, 0x14);

    /// <summary>Attention without alarm.</summary>
    public static readonly Rgb Amber = new(0xff, 0xb0, 0x00);

    /// <summary>Alarm.</summary>
    public static readonly Rgb Blood = new(0xff, 0x30, 0x50);

    /// <summary>Body text.</summary>
    public static readonly Rgb Text = new(0xd8, 0xdc, 0xe3);

    /// <summary>Secondary text: present, not competing.</summary>
    public static readonly Rgb Dim = new(0x6b, 0x5f, 0x8a);

    /// <summary>Inactive chrome.</summary>
    public static readonly Rgb Ghost = new(0x3a, 0x2d, 0x52);

    /// <summary>The bed a selected row sits on.</summary>
    public static readonly Rgb Selection = new(0x2a, 0x0a, 0x3e);

    /// <summary>Every colour in the palette, for anything that has to check them all.</summary>
    public static readonly IReadOnlyList<Rgb> All =
        [Void, Desktop, Neon, Cyan, Acid, Amber, Blood, Text, Dim, Ghost, Selection];

    /// <summary>
    /// The colour a session, route, or task state should be read in.
    /// </summary>
    /// <remarks>
    /// State is the main thing scanned for, so it gets the strongest signal on
    /// screen. One table for every vocabulary that has states, so a failure can
    /// never be the one that quietly falls through to grey.
    /// </remarks>
    public static Rgb StateColor(string state) => state switch
    {
        "ready" or "running" or "routed" => Acid,
        "starting" or "pulling" or "creating" => Cyan,
        "stopping" or "exited" or "unreachable" => Amber,
        "failed" or "gone" => Blood,
        _ => Dim,
    };

    /// <summary>The colour a log line's level is read in.</summary>
    public static Rgb LevelColor(string level) => level switch
    {
        "error" => Blood,
        "warn" => Amber,
        "info" => Cyan,
        _ => Dim,
    };
}
