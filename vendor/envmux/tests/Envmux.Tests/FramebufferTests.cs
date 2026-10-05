using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The screen signature, and the one thing on screen it must not look at.
/// </summary>
/// <remarks>
/// The signature answers "has this screen stopped changing", which the installer
/// wait turns into "has it finished". IncusOS draws a status bar along the top
/// with a clock in it, so a signature that samples the whole screen changes every
/// sixty seconds no matter what the machine is doing — and a stability window of
/// twenty seconds would then be reached by luck rather than by the installer
/// finishing.
/// </remarks>
public class FramebufferTests
{
    private const int Width = 640;
    private const int Height = 480;

    /// <summary>A screen of one colour.</summary>
    private static Screen Blank(byte shade = 0x10)
    {
        var pixels = new byte[Width * Height * 3];
        Array.Fill(pixels, shade);
        return new Screen(Width, Height, pixels);
    }

    /// <summary>Paint a band of rows, the way a line of text would.</summary>
    private static Screen Painted(Screen screen, int from, int to, byte shade)
    {
        var pixels = (byte[])screen.Pixels.Clone();

        for (var y = from; y < to; y++)
        {
            Array.Fill(pixels, shade, y * Width * 3, Width * 3);
        }

        return new Screen(screen.Width, screen.Height, pixels);
    }

    /// <summary>The same screen twice is the same number.</summary>
    [Fact]
    public void SameScreenSameSignature() =>
        Assert.Equal(Framebuffer.Signature(Blank()), Framebuffer.Signature(Blank()));

    /// <summary>
    /// The clock can tick all it likes.
    /// </summary>
    /// <remarks>
    /// This is the regression. Before it, a wait for a still screen could never
    /// see one still for more than a minute, so the install wait timed out on a
    /// machine that had finished in ten seconds.
    /// </remarks>
    [Fact]
    public void IgnoresTheStatusBar()
    {
        var before = Blank();

        // The bar is one line of text at the very top; everything below it is
        // the installer's log.
        var after = Painted(before, 0, 20, 0xF0);

        Assert.Equal(Framebuffer.Signature(before), Framebuffer.Signature(after));
    }

    /// <summary>Anything below the bar still counts.</summary>
    [Fact]
    public void NoticesTheRest()
    {
        var before = Blank();
        var after = Painted(before, Height / 2, Height, 0xF0);

        Assert.NotEqual(Framebuffer.Signature(before), Framebuffer.Signature(after));
    }

    /// <summary>
    /// A new line of log is a change, which is what "still working" looks like.
    /// </summary>
    [Fact]
    public void NoticesANewLineOfLog()
    {
        var before = Painted(Blank(), 100, 400, 0x40);
        var after = Painted(before, 400, 416, 0x40);

        Assert.NotEqual(Framebuffer.Signature(before), Framebuffer.Signature(after));
    }
}
