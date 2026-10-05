using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Envmux.Host;

/// <summary>The install image is not the shape this expects.</summary>
internal sealed class DiskImageException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>One entry from the image's GUID partition table.</summary>
/// <param name="Index">One-based, as the tools that print partition tables count.</param>
/// <param name="FirstLba">The first sector of the partition, inclusive.</param>
/// <param name="LastLba">The last sector, inclusive.</param>
/// <param name="TypeGuid">What the partition claims to be.</param>
/// <param name="Name">The label, when it has one.</param>
internal sealed record Partition(int Index, ulong FirstLba, ulong LastLba, Guid TypeGuid, string Name)
{
    public long Offset(int sectorSize) => (long)FirstLba * sectorSize;

    public long Length(int sectorSize) => (long)(LastLba - FirstLba + 1) * sectorSize;
}

/// <summary>
/// The install image, read as a partitioned disk.
/// </summary>
/// <remarks>
/// <para>
/// The seed goes at the start of the second partition — a raw byte offset into
/// the image, not a file on a filesystem. The offset is read out of the image's
/// own partition table rather than assumed, because assuming it means writing a
/// tar over whatever is actually there, and the failure appears as an install
/// that hangs on a machine with no console.
/// </para>
/// <para>
/// This reads GPT directly instead of shelling out to <c>parted</c>, which does
/// not exist on a Windows workstation. It is around forty bytes of header and
/// one entry, and the alternative is a dependency that would have to be
/// installed before the first build could run at all.
/// </para>
/// </remarks>
internal static class DiskImage
{
    private const string Signature = "EFI PART";

    /// <summary>The seed partition's documented size, and the ceiling on the tar.</summary>
    public const long SeedPartitionSize = 100L * 1024 * 1024;

    /// <summary>
    /// The two sector sizes worth trying.
    /// </summary>
    /// <remarks>
    /// The GPT header always lives in LBA 1, so where it is found <em>is</em> the
    /// sector size. Probing both is cheaper and more honest than reading a size
    /// out of the filesystem, which on Windows reports the size of the volume
    /// the image file happens to be sitting on rather than the image's own.
    /// </remarks>
    private static readonly int[] SectorSizes = [512, 4096];

    /// <summary>What the image's partition table says, and the sector size it is in.</summary>
    public static (IReadOnlyList<Partition> Partitions, int SectorSize) Read(string path)
    {
        if (!File.Exists(path))
        {
            throw new DiskImageException($"there is no image at {path}");
        }

        using var file = File.OpenRead(path);

        foreach (var sectorSize in SectorSizes)
        {
            if (file.Length < (long)sectorSize * 3)
            {
                continue;
            }

            var header = ReadAt(file, sectorSize, 92);

            if (Encoding.ASCII.GetString(header, 0, 8) != Signature)
            {
                continue;
            }

            var entryLba = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(72, 8));
            var count = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(80, 4));
            var size = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(84, 4));

            if (count is 0 or > 1024 || size is < 128 or > 4096)
            {
                throw new DiskImageException(
                    $"{path} has a GPT header claiming " +
                    $"{count.ToString(CultureInfo.InvariantCulture)} entries of " +
                    $"{size.ToString(CultureInfo.InvariantCulture)} bytes, which is not a partition table");
            }

            return (Entries(file, (long)entryLba * sectorSize, (int)count, (int)size), sectorSize);
        }

        throw new DiskImageException(
            $"{path} has no GPT partition table. IncusOS install media is GPT; a `.iso` or a " +
            "already-converted `.vhdx` is not what this step takes.");
    }

    private static List<Partition> Entries(Stream file, long offset, int count, int size)
    {
        var partitions = new List<Partition>();
        file.Seek(offset, SeekOrigin.Begin);

        var entry = new byte[size];

        for (var i = 0; i < count; i++)
        {
            file.ReadExactly(entry);

            var type = new Guid(entry.AsSpan(0, 16));
            if (type == Guid.Empty)
            {
                // An unused slot. The table is fixed-length and sparse at the
                // end, so this is where a real table stops rather than an error.
                continue;
            }

            var name = Encoding.Unicode.GetString(entry, 56, Math.Min(72, size - 56)).TrimEnd('\0');

            partitions.Add(new Partition(
                partitions.Count + 1,
                BinaryPrimitives.ReadUInt64LittleEndian(entry.AsSpan(32, 8)),
                BinaryPrimitives.ReadUInt64LittleEndian(entry.AsSpan(40, 8)),
                type,
                name));
        }

        return partitions;
    }

    /// <summary>
    /// Write the seed tar to the start of the image's second partition.
    /// </summary>
    /// <remarks>
    /// In place, on a copy the caller has already made. The install image is
    /// downloaded rather than built, and overwriting the download means the next
    /// build starts by downloading it again.
    /// </remarks>
    /// <returns>The byte offset it was written at.</returns>
    public static long InjectSeed(string path, byte[] archive)
    {
        var (partitions, sectorSize) = Read(path);

        if (partitions.Count < 2)
        {
            throw new DiskImageException(
                $"{path} has {partitions.Count.ToString(CultureInfo.InvariantCulture)} partition(s); " +
                "the seed goes on the second one");
        }

        var seed = partitions[1];
        var room = seed.Length(sectorSize);

        if (archive.LongLength > room)
        {
            throw new DiskImageException(
                $"the seed is {archive.LongLength.ToString(CultureInfo.InvariantCulture)} bytes and " +
                $"partition 2 holds {room.ToString(CultureInfo.InvariantCulture)}");
        }

        var offset = seed.Offset(sectorSize);

        using var file = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        file.Seek(offset, SeekOrigin.Begin);
        file.Write(archive);

        // The installer reads a tar, and a tar ends at its end-of-archive
        // marker — but anything left over from a previous seed after that
        // marker is still on the disk, and a rebuild that shrinks the seed
        // would otherwise leave the tail of the old one behind.
        var tail = Math.Min(room - archive.LongLength, 64L * 1024);
        if (tail > 0)
        {
            file.Write(new byte[tail]);
        }

        file.Flush();
        return offset;
    }

    /// <summary>Read back what is at the start of partition 2, for checking a build.</summary>
    public static byte[] ReadSeed(string path, int length)
    {
        var (partitions, sectorSize) = Read(path);

        if (partitions.Count < 2)
        {
            throw new DiskImageException($"{path} has no second partition to read a seed from");
        }

        using var file = File.OpenRead(path);
        file.Seek(partitions[1].Offset(sectorSize), SeekOrigin.Begin);

        var buffer = new byte[Math.Min(length, partitions[1].Length(sectorSize))];
        file.ReadExactly(buffer);
        return buffer;
    }

    private static byte[] ReadAt(Stream file, long offset, int length)
    {
        file.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[length];
        file.ReadExactly(buffer);
        return buffer;
    }
}
