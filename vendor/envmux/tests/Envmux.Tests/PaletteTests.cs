using Envmux.Ui;

namespace Envmux.Tests;

/// <summary>
/// The palette.
/// </summary>
/// <remarks>
/// These do not prove anything about what a terminal draws. They pin the
/// decisions, which is the half that logic can get wrong: that no two entries
/// are secretly the same colour, that text is legible on the ground it sits
/// on, and that no state anybody added falls through to grey.
/// </remarks>
public class PaletteTests
{
    [Fact]
    public void EverythingIsADistinctColour()
    {
        // Two palette entries that are the same colour are one colour with two
        // names, and the second one is the one somebody reaches for expecting a
        // difference on screen.
        Assert.Equal(Palette.All.Count, Palette.All.Distinct().Count());
    }

    [Fact]
    public void TheVoidIsDarkerThanTheTextOnIt()
    {
        Assert.True(Palette.Void.Luminance < Palette.Text.Luminance);
        Assert.True(Palette.Void.Luminance < Palette.Dim.Luminance);
        Assert.True(Palette.Selection.Luminance < Palette.Cyan.Luminance);
    }

    [Fact]
    public void TheDesktopIsLitOffTheVoidRatherThanEqualToIt()
    {
        // DOS put its windows on a patterned desktop, and the whole look
        // collapses if what is behind the panels is what is inside them.
        Assert.NotEqual(Palette.Void, Palette.Desktop);
        Assert.True(Palette.Void.Luminance < Palette.Desktop.Luminance);
    }

    [Theory]
    [InlineData("ready")]
    [InlineData("running")]
    [InlineData("routed")]
    [InlineData("starting")]
    [InlineData("pulling")]
    [InlineData("creating")]
    [InlineData("stopping")]
    [InlineData("exited")]
    [InlineData("unreachable")]
    [InlineData("failed")]
    [InlineData("gone")]
    public void EveryKnownStateGetsASignal(string state)
    {
        // A failed state rendering as grey is exactly what this table exists to
        // prevent.
        Assert.NotEqual(Palette.Dim, Palette.StateColor(state));
    }

    [Fact]
    public void FailureIsAlarmColoured()
    {
        Assert.Equal(Palette.Blood, Palette.StateColor("failed"));
        Assert.Equal(Palette.Blood, Palette.LevelColor("error"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("something-nobody-added-yet")]
    public void UnknownStatesAreQuietRatherThanLoud(string state)
    {
        // A state we have not seen should not shout. Falling back to alarm would
        // train people to ignore alarm.
        Assert.Equal(Palette.Dim, Palette.StateColor(state));
        Assert.Equal(Palette.Dim, Palette.LevelColor(state));
    }

    [Fact]
    public void LuminanceWeightsTheChannelsRatherThanAveragingThem()
    {
        // The eye is not equally sensitive to the three. An unweighted average
        // would call this blue as bright as this green, and the palette's
        // contrast checks would pass on colours nobody can read.
        var green = new Rgb(0x00, 0xff, 0x00);
        var blue = new Rgb(0x00, 0x00, 0xff);

        Assert.True(green.Luminance > blue.Luminance);
        Assert.Equal(1.0, new Rgb(0xff, 0xff, 0xff).Luminance, 3);
        Assert.Equal(0.0, new Rgb(0x00, 0x00, 0x00).Luminance, 3);
    }
}
