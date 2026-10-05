using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The PNG encoder, decoded again.
/// </summary>
/// <remarks>
/// Written from the specification rather than taken from a library, so it is
/// checked by taking it apart: the chunks, their CRCs, the zlib wrapper, the
/// filter bytes and the pixels back out. A screenshot that a viewer refuses to
/// open is worse than no screenshot, because it looks like the capture failed.
/// </remarks>
public class PngTests
{
    private static readonly byte[] Signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>Walk the chunks, checking each CRC on the way past.</summary>
    private static List<(string Type, byte[] Data)> Chunks(byte[] png)
    {
        Assert.True(png.Length > 8, "far too short to be a PNG");
        Assert.Equal(Signature, png[..8]);

        var chunks = new List<(string, byte[])>();
        var at = 8;

        while (at < png.Length)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(at, 4));
            var type = Encoding.ASCII.GetString(png, at + 4, 4);
            var data = png[(at + 8)..(at + 8 + length)];

            var claimed = BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(at + 8 + length, 4));
            var actual = System.IO.Hashing.Crc32.HashToUInt32(png.AsSpan(at + 4, 4 + length));

            Assert.Equal(actual, claimed);

            chunks.Add((type, data));
            at += 12 + length;
        }

        return chunks;
    }

    /// <summary>Undo the zlib wrapper and the per-scanline filter byte.</summary>
    private static byte[] Pixels(byte[] idat, int width, int height)
    {
        Assert.Equal(0x78, idat[0]);
        Assert.Equal(0, (idat[0] * 256 + idat[1]) % 31);

        using var compressed = new MemoryStream(idat, 2, idat.Length - 6);
        using var inflate = new DeflateStream(compressed, CompressionMode.Decompress);
        using var raw = new MemoryStream();
        inflate.CopyTo(raw);

        var bytes = raw.ToArray();
        var stride = width * 3;

        Assert.Equal(height * (stride + 1), bytes.Length);

        var pixels = new byte[height * stride];

        for (var y = 0; y < height; y++)
        {
            Assert.Equal(0, bytes[y * (stride + 1)]);
            bytes.AsSpan((y * (stride + 1)) + 1, stride).CopyTo(pixels.AsSpan(y * stride));
        }

        return pixels;
    }

    [Fact]
    public void ItIsASignatureAndThreeChunksInOrder()
    {
        var chunks = Chunks(Png.Encode(new byte[4 * 3 * 3], 4, 3));

        Assert.Equal(["IHDR", "IDAT", "IEND"], chunks.Select(c => c.Type));
        Assert.Empty(chunks[^1].Data);
    }

    [Fact]
    public void TheHeaderSaysWhatItIs()
    {
        var header = Chunks(Png.Encode(new byte[7 * 5 * 3], 7, 5))[0].Data;

        Assert.Equal(13, header.Length);
        Assert.Equal(7, BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(0)));
        Assert.Equal(5, BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(4)));
        Assert.Equal(8, header[8]);   // bits per channel
        Assert.Equal(2, header[9]);   // truecolour
        Assert.Equal(0, header[10]);  // deflate
        Assert.Equal(0, header[11]);  // adaptive filtering
        Assert.Equal(0, header[12]);  // not interlaced
    }

    [Fact]
    public void ThePixelsSurviveTheRoundTrip()
    {
        var pixels = new byte[6 * 4 * 3];
        Random.Shared.NextBytes(pixels);

        var decoded = Pixels(Chunks(Png.Encode(pixels, 6, 4))[1].Data, 6, 4);

        Assert.Equal(pixels, decoded);
    }

    [Fact]
    public void TheAdlerChecksumIsTheOneZlibWants()
    {
        var pixels = new byte[3 * 2 * 3];
        Random.Shared.NextBytes(pixels);

        var idat = Chunks(Png.Encode(pixels, 3, 2))[1].Data;
        var claimed = BinaryPrimitives.ReadUInt32BigEndian(idat.AsSpan(idat.Length - 4));

        // Recomputed over the uncompressed stream, which is the scanlines with
        // their filter bytes rather than the pixels.
        using var compressed = new MemoryStream(idat, 2, idat.Length - 6);
        using var inflate = new DeflateStream(compressed, CompressionMode.Decompress);
        using var raw = new MemoryStream();
        inflate.CopyTo(raw);

        uint a = 1;
        uint b = 0;

        foreach (var value in raw.ToArray())
        {
            a = (a + value) % 65521;
            b = (b + a) % 65521;
        }

        Assert.Equal((b << 16) | a, claimed);
    }

    [Fact]
    public void AMismatchedBufferIsRefusedRatherThanTruncated()
    {
        var thrown = Assert.Throws<ArgumentException>(() => Png.Encode(new byte[10], 4, 4));
        Assert.Contains("48 bytes", thrown.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(0, 4)]
    [InlineData(4, 0)]
    [InlineData(-1, 4)]
    public void AnImageWithNoAreaIsRefused(int width, int height) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => Png.Encode([], width, height));
}

/// <summary>
/// Hyper-V hands the framebuffer back as RGB565, which is not a format anything
/// else here speaks.
/// </summary>
public class Rgb565Tests
{
    private static byte[] Packed(params ushort[] pixels)
    {
        var bytes = new byte[pixels.Length * 2];

        for (var i = 0; i < pixels.Length; i++)
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(i * 2), pixels[i]);
        }

        return bytes;
    }

    [Fact]
    public void FullScaleStaysFullScale()
    {
        // Shifting alone would turn 0x1F into 0xF8 and leave white looking
        // slightly grey, which on a screenshot of a text console is the whole
        // image.
        var pixels = Png.FromRgb565(Packed(0xFFFF), 1, 1);

        Assert.Equal([0xFF, 0xFF, 0xFF], pixels);
    }

    [Fact]
    public void BlackIsBlack() =>
        Assert.Equal([0x00, 0x00, 0x00], Png.FromRgb565(Packed(0x0000), 1, 1));

    [Fact]
    public void TheChannelsAreInTheRightOrderAndTheRightWidths()
    {
        // 0xF800 is red at full scale, 0x07E0 green, 0x001F blue — and green
        // has the extra bit, which is where the eye has the most resolution.
        Assert.Equal([0xFF, 0x00, 0x00], Png.FromRgb565(Packed(0xF800), 1, 1));
        Assert.Equal([0x00, 0xFF, 0x00], Png.FromRgb565(Packed(0x07E0), 1, 1));
        Assert.Equal([0x00, 0x00, 0xFF], Png.FromRgb565(Packed(0x001F), 1, 1));
    }

    [Fact]
    public void ItReadsLittleEndian()
    {
        // The bytes 0x00 0xF8 are 0xF800, which is red. Read the other way they
        // would be 0x00F8 — a dark blue — and every screenshot would come out
        // in the wrong colours rather than failing.
        Assert.Equal([0xFF, 0x00, 0x00], Png.FromRgb565([0x00, 0xF8], 1, 1));
    }

    [Fact]
    public void RowsComeOutInOrder()
    {
        var pixels = Png.FromRgb565(Packed(0xF800, 0x001F, 0x07E0, 0xFFFF), 2, 2);

        Assert.Equal([0xFF, 0x00, 0x00], pixels[..3]);
        Assert.Equal([0x00, 0x00, 0xFF], pixels[3..6]);
        Assert.Equal([0x00, 0xFF, 0x00], pixels[6..9]);
        Assert.Equal([0xFF, 0xFF, 0xFF], pixels[9..]);
    }

    [Fact]
    public void ABufferTooSmallForTheModeIsRefused()
    {
        // A short read here would otherwise be a screenshot of whatever was in
        // memory after it.
        var thrown = Assert.Throws<ArgumentException>(() => Png.FromRgb565(new byte[10], 100, 100));
        Assert.Contains("20000 bytes", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AScreenEncodesToSomethingAViewerWouldOpen()
    {
        // End to end, at a real console size: RGB565 in, PNG out.
        var framebuffer = new byte[720 * 400 * 2];
        Random.Shared.NextBytes(framebuffer);

        var screen = new Screen(720, 400, Png.FromRgb565(framebuffer, 720, 400));
        var png = screen.ToPng();

        Assert.Equal([0x89, 0x50, 0x4E, 0x47], png[..4]);
        Assert.Equal(720, BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)));
        Assert.Equal(400, BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20)));
    }
}
