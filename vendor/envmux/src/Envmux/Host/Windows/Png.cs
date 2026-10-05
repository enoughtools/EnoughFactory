using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace Envmux.Host.Windows;

/// <summary>
/// A PNG encoder, because the alternative is a dependency for one file format.
/// </summary>
/// <remarks>
/// <para>
/// <c>System.Drawing.Common</c> would do this in three lines and is Windows-only
/// as of .NET 6 — it throws on every other platform — so taking it would mean
/// taking a platform restriction into a project that has one folder of
/// Windows-specific code and wants to keep it that way. ImageSharp would do it
/// too, and is a megabyte and a release cadence for saving a screenshot.
/// </para>
/// <para>
/// PNG is a signature, three chunks and a CRC. The compression is deflate, which
/// is in the BCL, and the only part anyone gets wrong is the zlib wrapper the
/// spec requires around it and the per-scanline filter byte.
/// </para>
/// </remarks>
internal static class Png
{
    private static readonly byte[] Signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>
    /// Encode 8-bit RGB triples, top row first, as a PNG.
    /// </summary>
    /// <param name="pixels">Exactly <c>width * height * 3</c> bytes.</param>
    public static byte[] Encode(ReadOnlySpan<byte> pixels, int width, int height)
    {
        if (width <= 0 || height <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(width), "an image needs both dimensions");
        }

        if (pixels.Length != width * height * 3)
        {
            throw new ArgumentException(
                $"expected {width * height * 3} bytes for {width}x{height}, got {pixels.Length}", nameof(pixels));
        }

        using var png = new MemoryStream();
        png.Write(Signature);

        var header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0), width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8;  // bits per channel
        header[9] = 2;  // truecolour, no alpha
        header[10] = 0; // deflate, the only compression PNG has
        header[11] = 0; // adaptive filtering, the only filter method PNG has
        header[12] = 0; // not interlaced

        Chunk(png, "IHDR", header);
        Chunk(png, "IDAT", Compress(pixels, width, height));
        Chunk(png, "IEND", []);

        return png.ToArray();
    }

    /// <summary>
    /// The image data, as the zlib stream PNG asks for.
    /// </summary>
    /// <remarks>
    /// Every scanline is prefixed with a filter byte, and zero means "no filter"
    /// — the row is stored as it is. A real encoder would try the five filters
    /// per row and keep the smallest; this is a screenshot of a text console,
    /// which deflate flattens regardless, and the arithmetic is not worth the
    /// code.
    /// </remarks>
    private static byte[] Compress(ReadOnlySpan<byte> pixels, int width, int height)
    {
        var stride = width * 3;
        var raw = new byte[height * (stride + 1)];

        for (var y = 0; y < height; y++)
        {
            raw[y * (stride + 1)] = 0;
            pixels.Slice(y * stride, stride).CopyTo(raw.AsSpan((y * (stride + 1)) + 1));
        }

        using var zlib = new MemoryStream();

        // The two-byte zlib header DeflateStream does not write: 0x78 is a
        // 32K window with deflate, 0x01 is the check byte that makes the pair
        // divide by 31. Without it a decoder rejects the stream outright.
        zlib.WriteByte(0x78);
        zlib.WriteByte(0x01);

        using (var deflate = new DeflateStream(zlib, CompressionLevel.Optimal, leaveOpen: true))
        {
            deflate.Write(raw);
        }

        Span<byte> adler = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(adler, Adler32(raw));
        zlib.Write(adler);

        return zlib.ToArray();
    }

    private static void Chunk(Stream png, string type, ReadOnlySpan<byte> data)
    {
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        png.Write(length);

        var body = new byte[4 + data.Length];
        Encoding.ASCII.GetBytes(type, body.AsSpan(0, 4));
        data.CopyTo(body.AsSpan(4));
        png.Write(body);

        Span<byte> crc = stackalloc byte[4];

        // The CRC covers the type and the data, and not the length in front of
        // them — which is the other thing everybody gets wrong.
        BinaryPrimitives.WriteUInt32BigEndian(crc, System.IO.Hashing.Crc32.HashToUInt32(body));
        png.Write(crc);
    }

    /// <summary>zlib's checksum: two running sums, modulo the largest prime below 65536.</summary>
    private static uint Adler32(ReadOnlySpan<byte> data)
    {
        const uint Modulus = 65521;

        uint a = 1;
        uint b = 0;

        foreach (var value in data)
        {
            a = (a + value) % Modulus;
            b = (b + a) % Modulus;
        }

        return (b << 16) | a;
    }

    /// <summary>
    /// Turn Hyper-V's framebuffer into the triples <see cref="Encode"/> takes.
    /// </summary>
    /// <remarks>
    /// The thumbnail comes back as RGB565: five bits of red, six of green, five
    /// of blue, packed little-endian. The green channel has the extra bit
    /// because that is where the eye has the most resolution.
    /// </remarks>
    public static byte[] FromRgb565(ReadOnlySpan<byte> framebuffer, int width, int height)
    {
        var expected = width * height * 2;

        if (framebuffer.Length < expected)
        {
            throw new ArgumentException(
                $"expected {expected} bytes of RGB565 for {width}x{height}, got {framebuffer.Length}",
                nameof(framebuffer));
        }

        var pixels = new byte[width * height * 3];

        for (var i = 0; i < width * height; i++)
        {
            var packed = BinaryPrimitives.ReadUInt16LittleEndian(framebuffer.Slice(i * 2, 2));

            var r = (packed >> 11) & 0x1F;
            var g = (packed >> 5) & 0x3F;
            var b = packed & 0x1F;

            // Scaled by repeating the high bits into the low ones, so full
            // scale stays full scale — 0x1F becomes 0xFF rather than 0xF8.
            pixels[(i * 3) + 0] = (byte)((r << 3) | (r >> 2));
            pixels[(i * 3) + 1] = (byte)((g << 2) | (g >> 4));
            pixels[(i * 3) + 2] = (byte)((b << 3) | (b >> 2));
        }

        return pixels;
    }
}
