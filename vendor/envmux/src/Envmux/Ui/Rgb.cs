namespace Envmux.Ui;

/// <summary>
/// A colour, as the three bytes a terminal is told.
/// </summary>
/// <remarks>
/// <para>
/// Forty lines rather than a toolkit. This used to be
/// <c>Avalonia.Media.Color</c>, which arrived with a UI framework attached and
/// was used for the one thing every colour type does: hold three bytes and
/// hand them back. A terminal is told a colour as <c>38;2;r;g;b</c> and there
/// is nothing else envmux needs a colour to do.
/// </para>
/// <para>
/// No alpha. Nothing composites here — a cell is one colour on one other
/// colour — and an alpha channel that is always 255 is a field that exists to
/// be asserted about.
/// </para>
/// </remarks>
internal readonly record struct Rgb(byte R, byte G, byte B)
{
    /// <summary>
    /// How light this reads, 0 to 1.
    /// </summary>
    /// <remarks>
    /// Rec. 709 weights, because the eye is not equally sensitive to the three
    /// and an unweighted average calls a saturated blue as bright as a
    /// saturated green. Used to keep the palette's contrast honest rather than
    /// to draw anything.
    /// </remarks>
    public double Luminance => ((0.2126 * R) + (0.7152 * G) + (0.0722 * B)) / 255.0;
}
