using System.Buffers.Binary;
using System.Text;

namespace Envmux.Host.Windows;

/// <summary>
/// The 512 bytes that turn a raw disk image into a file Hyper-V will open.
/// </summary>
/// <remarks>
/// <para>
/// Hyper-V cannot boot a raw <c>.img</c>, and the documented way across is
/// <c>qemu-img convert</c> — a tool that is not on a Windows workstation and
/// that would have to be installed before the first build could run. A fixed
/// VHD, though, <em>is</em> a raw image: the payload is the disk, byte for byte,
/// followed by this footer. Appending it costs one write, and
/// <c>Convert-VHD</c> — which ships with the Hyper-V role this design already
/// requires — turns the result into the VHDX a Generation 2 VM needs.
/// </para>
/// <para>
/// So the conversion needs nothing that is not already installed. qemu-img is
/// still used when it happens to be on PATH, because it produces a dynamic VHDX
/// in one step rather than two.
/// </para>
/// </remarks>
internal static class VhdFooter
{
    public const int Length = 512;

    /// <summary>VHD timestamps count from this, not from the Unix epoch.</summary>
    private static readonly DateTimeOffset Epoch = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>
    /// Build the footer for a disk of this many bytes.
    /// </summary>
    /// <param name="size">The payload size. Must be a whole number of 512-byte sectors.</param>
    /// <param name="id">The disk's unique id, passed in so a build is reproducible.</param>
    /// <param name="now">The creation timestamp, likewise.</param>
    public static byte[] For(long size, Guid id, DateTimeOffset now)
    {
        if (size <= 0 || size % 512 != 0)
        {
            throw new DiskImageException(
                $"a VHD payload must be a whole number of 512-byte sectors; this one is {size} bytes");
        }

        var footer = new byte[Length];
        var span = footer.AsSpan();

        Encoding.ASCII.GetBytes("conectix", span[..8]);

        // Bit 1 is the one every implementation sets and none of them agree on
        // the meaning of. Set it, because a footer without it is rejected.
        BinaryPrimitives.WriteUInt32BigEndian(span[8..], 0x0000_0002);

        // File format version 1.0.
        BinaryPrimitives.WriteUInt32BigEndian(span[12..], 0x0001_0000);

        // A fixed disk has no dynamic header to point at, and says so with the
        // largest possible offset rather than with a zero.
        BinaryPrimitives.WriteUInt64BigEndian(span[16..], ulong.MaxValue);

        BinaryPrimitives.WriteUInt32BigEndian(span[24..], (uint)(now - Epoch).TotalSeconds);

        Encoding.ASCII.GetBytes("emux", span[28..32]);
        BinaryPrimitives.WriteUInt32BigEndian(span[32..], 0x0001_0000);

        // "Wi2k". Windows tooling reads this and a Linux value would only
        // invite questions about a file that is only ever opened by Hyper-V.
        Encoding.ASCII.GetBytes("Wi2k", span[36..40]);

        BinaryPrimitives.WriteUInt64BigEndian(span[40..], (ulong)size);
        BinaryPrimitives.WriteUInt64BigEndian(span[48..], (ulong)size);

        var (cylinders, heads, sectors) = Geometry(size / 512);
        BinaryPrimitives.WriteUInt16BigEndian(span[56..], cylinders);
        footer[58] = heads;
        footer[59] = sectors;

        // 2 is fixed. 3 is dynamic and 4 is differencing, neither of which this
        // writes: both need a second header and a block allocation table, and
        // Convert-VHD produces a dynamic VHDX from this in one call anyway.
        BinaryPrimitives.WriteUInt32BigEndian(span[60..], 2);

        id.TryWriteBytes(span[68..84]);

        // Last, over a footer whose checksum field is still zero.
        BinaryPrimitives.WriteUInt32BigEndian(span[64..], Checksum(footer));

        return footer;
    }

    /// <summary>
    /// The ones' complement of the sum of every byte.
    /// </summary>
    /// <remarks>
    /// Computed with the checksum field itself zero, which is why it is written
    /// after everything else rather than in place.
    /// </remarks>
    private static uint Checksum(byte[] footer)
    {
        uint sum = 0;
        foreach (var b in footer)
        {
            sum += b;
        }

        return ~sum;
    }

    /// <summary>
    /// The CHS geometry, by the algorithm in the VHD specification.
    /// </summary>
    /// <remarks>
    /// Nothing reads these numbers to find data — the payload is flat and the
    /// size fields say how big it is. They exist because the format predates
    /// that being obvious, and a footer whose geometry does not multiply out
    /// near the stated size is rejected by some readers.
    /// </remarks>
    internal static (ushort Cylinders, byte Heads, byte Sectors) Geometry(long totalSectors)
    {
        // The largest disk CHS can describe. Beyond it the geometry is a
        // fiction and the size fields are what count.
        const long Max = 65535L * 16 * 255;

        if (totalSectors > Max)
        {
            totalSectors = Max;
        }

        long sectorsPerTrack;
        long heads;
        long cylinderTimesHeads;

        if (totalSectors >= 65535L * 16 * 63)
        {
            sectorsPerTrack = 255;
            heads = 16;
            cylinderTimesHeads = totalSectors / sectorsPerTrack;
        }
        else
        {
            sectorsPerTrack = 17;
            cylinderTimesHeads = totalSectors / sectorsPerTrack;

            heads = (cylinderTimesHeads + 1023) / 1024;
            if (heads < 4)
            {
                heads = 4;
            }

            if (cylinderTimesHeads >= heads * 1024 || heads > 16)
            {
                sectorsPerTrack = 31;
                heads = 16;
                cylinderTimesHeads = totalSectors / sectorsPerTrack;
            }

            if (cylinderTimesHeads >= heads * 1024)
            {
                sectorsPerTrack = 63;
                heads = 16;
                cylinderTimesHeads = totalSectors / sectorsPerTrack;
            }
        }

        return ((ushort)(cylinderTimesHeads / heads), (byte)heads, (byte)sectorsPerTrack);
    }

    /// <summary>
    /// Copy a raw image to a new file and append the footer, making it a VHD.
    /// </summary>
    /// <returns>The path written.</returns>
    public static async Task<string> WriteAsync(
        string rawImage,
        string vhdPath,
        Guid id,
        DateTimeOffset now,
        CancellationToken ct = default)
    {
        var length = new FileInfo(rawImage).Length;

        if (length % 512 != 0)
        {
            throw new DiskImageException(
                $"{rawImage} is {length} bytes, which is not a whole number of sectors — " +
                "it is probably not a raw disk image");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(vhdPath))!);

        await using (var source = File.OpenRead(rawImage))
        await using (var destination = File.Create(vhdPath))
        {
            await source.CopyToAsync(destination, ct).ConfigureAwait(false);
            await destination.WriteAsync(For(length, id, now), ct).ConfigureAwait(false);
        }

        return vhdPath;
    }
}
