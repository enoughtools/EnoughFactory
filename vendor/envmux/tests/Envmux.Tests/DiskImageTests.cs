using System.Buffers.Binary;
using System.Formats.Tar;
using System.Text;

using Envmux.Host;
using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The seed goes at a raw byte offset inside a disk image. Getting the offset
/// wrong writes a tar over a filesystem and produces an install that hangs on a
/// machine with no console, so the offset is read out of the image's own
/// partition table and this is what checks that reading.
/// </summary>
public class DiskImageTests
{
    private const int SectorSize = 512;

    /// <summary>
    /// A GPT image with the partitions asked for, and nothing else in it.
    /// </summary>
    /// <remarks>
    /// Built rather than fetched: the real IncusOS media is gigabytes, and every
    /// property this exercises — where the header is, where the entries are, how
    /// big partition two is — is in the first few kilobytes.
    /// </remarks>
    private static string Image(params (ulong First, ulong Last, string Name)[] partitions)
    {
        var path = Path.Combine(Path.GetTempPath(), $"envmux-gpt-{Guid.NewGuid():N}.img");
        var sectors = partitions.Length == 0 ? 64 : (long)partitions[^1].Last + 2;
        var bytes = new byte[sectors * SectorSize];

        // The header lives in LBA 1. Where it is found is what the reader
        // decides the sector size from.
        var header = bytes.AsSpan(SectorSize);
        Encoding.ASCII.GetBytes("EFI PART").CopyTo(header);
        BinaryPrimitives.WriteUInt64LittleEndian(header[72..], 2);
        BinaryPrimitives.WriteUInt32LittleEndian(header[80..], 128);
        BinaryPrimitives.WriteUInt32LittleEndian(header[84..], 128);

        for (var i = 0; i < partitions.Length; i++)
        {
            var entry = bytes.AsSpan((2 * SectorSize) + (i * 128), 128);

            Guid.NewGuid().TryWriteBytes(entry[..16]);
            Guid.NewGuid().TryWriteBytes(entry[16..32]);
            BinaryPrimitives.WriteUInt64LittleEndian(entry[32..], partitions[i].First);
            BinaryPrimitives.WriteUInt64LittleEndian(entry[40..], partitions[i].Last);
            Encoding.Unicode.GetBytes(partitions[i].Name).CopyTo(entry[56..]);
        }

        File.WriteAllBytes(path, bytes);
        return path;
    }

    [Fact]
    public void ReadsThePartitionTableOutOfTheImage()
    {
        var path = Image((2048, 6143, "esp"), (6144, 8191, "seed"), (8192, 10239, "root"));

        try
        {
            var (partitions, sectorSize) = DiskImage.Read(path);

            Assert.Equal(512, sectorSize);
            Assert.Equal(3, partitions.Count);
            Assert.Equal("seed", partitions[1].Name);
            Assert.Equal(6144L * 512, partitions[1].Offset(sectorSize));

            // Inclusive at both ends: 6144 through 8191 is 2048 sectors, not 2047.
            Assert.Equal(2048L * 512, partitions[1].Length(sectorSize));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void EmptySlotsAtTheEndOfTheTableAreNotPartitions()
    {
        // A GPT entry array is fixed length and mostly zeroes. Counting the
        // zeroes would make partition two the wrong one.
        var path = Image((2048, 4095, "one"), (4096, 6143, "two"));

        try
        {
            Assert.Equal(2, DiskImage.Read(path).Partitions.Count);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void SomethingThatIsNotGptIsRefusedWithASentenceAboutIt()
    {
        var path = Path.Combine(Path.GetTempPath(), $"envmux-nogpt-{Guid.NewGuid():N}.img");
        File.WriteAllBytes(path, new byte[64 * 512]);

        try
        {
            var thrown = Assert.Throws<DiskImageException>(() => DiskImage.Read(path));
            Assert.Contains("GPT", thrown.Message, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void TheSeedLandsAtTheStartOfPartitionTwoAndReadsBackAsATar()
    {
        var path = Image((2048, 6143, "esp"), (6144, 8191, "seed"), (8192, 10239, "root"));
        var archive = Seed.Archive(Seed.Files(new HostConfig(), "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----"));

        try
        {
            var offset = DiskImage.InjectSeed(path, archive);

            Assert.Equal(6144L * 512, offset);

            using var stream = new MemoryStream(DiskImage.ReadSeed(path, archive.Length));
            using var reader = new TarReader(stream);

            Assert.Equal("install.json", reader.GetNextEntry()!.Name);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void NothingOutsideThePartitionIsTouched()
    {
        var path = Image((2048, 6143, "esp"), (6144, 8191, "seed"), (8192, 10239, "root"));

        try
        {
            // A recognisable byte in the partition before, and in the one after.
            using (var file = File.Open(path, FileMode.Open, FileAccess.ReadWrite))
            {
                file.Seek((6144L * 512) - 1, SeekOrigin.Begin);
                file.WriteByte(0xAA);
                file.Seek(8192L * 512, SeekOrigin.Begin);
                file.WriteByte(0xBB);
            }

            DiskImage.InjectSeed(path, Seed.Archive(Seed.Files(new HostConfig(), "x")));

            var bytes = File.ReadAllBytes(path);
            Assert.Equal(0xAA, bytes[(6144 * 512) - 1]);
            Assert.Equal(0xBB, bytes[8192 * 512]);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ASeedTooBigForItsPartitionIsRefusedRatherThanTruncated()
    {
        // One sector of room. Writing past it would corrupt whatever is next,
        // and the install would fail somewhere else entirely.
        var path = Image((2048, 4095, "esp"), (4096, 4096, "seed"), (4097, 6143, "root"));

        try
        {
            var thrown = Assert.Throws<DiskImageException>(
                () => DiskImage.InjectSeed(path, Seed.Archive(Seed.Files(new HostConfig(), "x"))));

            Assert.Contains("partition 2 holds", thrown.Message, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void AnImageWithOnlyOnePartitionHasNowhereToPutASeed()
    {
        var path = Image((2048, 6143, "esp"));

        try
        {
            Assert.Throws<DiskImageException>(
                () => DiskImage.InjectSeed(path, Seed.Archive(Seed.Files(new HostConfig(), "x"))));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ReseedingLeavesNoneOfTheOldSeedBehind()
    {
        var path = Image((2048, 6143, "esp"), (6144, 8191, "seed"), (8192, 10239, "root"));

        try
        {
            var big = Seed.Archive(Seed.Files(new HostConfig { DnsDomain = "averylongdomainnamehere" }, new string('x', 4000)));
            DiskImage.InjectSeed(path, big);

            var small = Seed.Archive(Seed.Files(new HostConfig(), "x"));
            DiskImage.InjectSeed(path, small);

            // The tar ends where it ends, but the tail of the previous, larger
            // seed must not still be sitting behind it.
            var after = DiskImage.ReadSeed(path, big.Length);
            Assert.All(after.Skip(small.Length), b => Assert.Equal(0, b));
        }
        finally
        {
            File.Delete(path);
        }
    }
}

/// <summary>
/// Hyper-V will not boot a raw image, and qemu-img is not on a Windows
/// workstation. A fixed VHD is the raw image plus these 512 bytes, and
/// Convert-VHD — which ships with the Hyper-V role this design already needs —
/// takes it the rest of the way.
/// </summary>
public class VhdFooterTests
{
    [Fact]
    public void TheFooterIsExactlyOneSector() =>
        Assert.Equal(512, VhdFooter.For(1024 * 1024, Guid.NewGuid(), DateTimeOffset.UnixEpoch).Length);

    [Fact]
    public void ItStartsWithTheCookieEveryReaderLooksFor()
    {
        var footer = VhdFooter.For(1024 * 1024, Guid.NewGuid(), DateTimeOffset.UnixEpoch);

        Assert.Equal("conectix", Encoding.ASCII.GetString(footer, 0, 8));
    }

    [Fact]
    public void TheChecksumIsTheOnesComplementOfEverythingElse()
    {
        var footer = VhdFooter.For(64 * 1024 * 1024, Guid.NewGuid(), DateTimeOffset.UnixEpoch);
        var claimed = BinaryPrimitives.ReadUInt32BigEndian(footer.AsSpan(64, 4));

        // Recomputed the way a reader does it: zero the field, sum, complement.
        BinaryPrimitives.WriteUInt32BigEndian(footer.AsSpan(64, 4), 0);

        uint sum = 0;
        foreach (var b in footer)
        {
            sum += b;
        }

        Assert.Equal(~sum, claimed);
    }

    [Fact]
    public void ItDeclaresItselfFixedAndSaysHowBigTheDiskIs()
    {
        const long Size = 4L * 1024 * 1024 * 1024;
        var footer = VhdFooter.For(Size, Guid.NewGuid(), DateTimeOffset.UnixEpoch);

        // 0xFFFFFFFFFFFFFFFF at 16 is what "there is no dynamic header" is
        // spelled as, and 2 at 60 is the disk type.
        Assert.Equal(ulong.MaxValue, BinaryPrimitives.ReadUInt64BigEndian(footer.AsSpan(16, 8)));
        Assert.Equal(2u, BinaryPrimitives.ReadUInt32BigEndian(footer.AsSpan(60, 4)));
        Assert.Equal((ulong)Size, BinaryPrimitives.ReadUInt64BigEndian(footer.AsSpan(40, 8)));
        Assert.Equal((ulong)Size, BinaryPrimitives.ReadUInt64BigEndian(footer.AsSpan(48, 8)));
    }

    [Theory]
    [InlineData(2048)]
    [InlineData(1024 * 1024)]
    [InlineData(16L * 1024 * 1024 * 2)]
    [InlineData(100L * 1024 * 1024 * 2)]
    public void TheGeometryMultipliesOutToNearlyTheDisk(long sectors)
    {
        var (cylinders, heads, sectorsPerTrack) = VhdFooter.Geometry(sectors);

        var described = (long)cylinders * heads * sectorsPerTrack;

        Assert.True(described <= sectors, "geometry describes more sectors than the disk has");

        // Truncation loses at most one cylinder's worth.
        Assert.True(sectors - described < (long)heads * sectorsPerTrack * 2,
            $"geometry {cylinders}/{heads}/{sectorsPerTrack} leaves too much of {sectors} undescribed");
    }

    [Fact]
    public void ADiskTooBigForChsIsDescribedAsTheLargestOneThatFits()
    {
        // Past 128 GiB the geometry stops being able to describe the disk at
        // all. It saturates rather than wrapping, and the size fields — which
        // are what anything actually reads — still say how big it really is.
        const long Huge = 500L * 1024 * 1024 * 2;
        var (cylinders, heads, sectorsPerTrack) = VhdFooter.Geometry(Huge);

        Assert.Equal(65535, cylinders);
        Assert.Equal(16, heads);
        Assert.Equal(255, sectorsPerTrack);

        var footer = VhdFooter.For(Huge * 512, Guid.NewGuid(), DateTimeOffset.UnixEpoch);
        Assert.Equal((ulong)(Huge * 512), BinaryPrimitives.ReadUInt64BigEndian(footer.AsSpan(48, 8)));
    }

    [Fact]
    public void AnImageThatIsNotAWholeNumberOfSectorsIsRefused()
    {
        // Very likely a truncated download, and a VHD built from one boots to a
        // firmware error rather than to an installer.
        Assert.Throws<DiskImageException>(() => VhdFooter.For(1000, Guid.NewGuid(), DateTimeOffset.UnixEpoch));
    }

    [Fact]
    public async Task TheVhdIsTheImageFollowedByTheFooter()
    {
        var raw = Path.Combine(Path.GetTempPath(), $"envmux-raw-{Guid.NewGuid():N}.img");
        var vhd = Path.Combine(Path.GetTempPath(), $"envmux-raw-{Guid.NewGuid():N}.vhd");

        var payload = new byte[4096];
        Random.Shared.NextBytes(payload);
        await File.WriteAllBytesAsync(raw, payload);

        try
        {
            await VhdFooter.WriteAsync(raw, vhd, Guid.NewGuid(), DateTimeOffset.UnixEpoch);

            var written = await File.ReadAllBytesAsync(vhd);

            Assert.Equal(payload.Length + 512, written.Length);
            Assert.Equal(payload, written[..payload.Length]);
            Assert.Equal("conectix", Encoding.ASCII.GetString(written, payload.Length, 8));
        }
        finally
        {
            File.Delete(raw);
            File.Delete(vhd);
        }
    }
}
