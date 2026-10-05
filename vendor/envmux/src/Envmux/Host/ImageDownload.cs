using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;

namespace Envmux.Host;

/// <summary>
/// Fetching a published image, checking it, and unpacking it once.
/// </summary>
/// <remarks>
/// <para>
/// Six hundred megabytes compressed and several gigabytes unpacked, so this is
/// the slowest step of an install by a distance and the one most worth being
/// able to skip. The unpacked image is kept under the home directory and named
/// for its build, so a second host — or a rebuild after a mistake — costs
/// nothing.
/// </para>
/// <para>
/// The checksum is not decoration. This file is about to be seeded with a
/// private credential and installed unattended on a machine with no console; a
/// truncated download would produce a VM that fails somewhere unrelated, hours
/// later, with nothing pointing back here.
/// </para>
/// </remarks>
internal static class ImageDownload
{
    /// <summary>Where builds are kept, so one is downloaded once per machine.</summary>
    public static string Directory => Path.Combine(HostConfig.Directory, "images");

    /// <summary>
    /// Make sure this build is on disk, unpacked, and hand back the path.
    /// </summary>
    /// <remarks>
    /// Idempotent by construction: the unpacked name carries the version, so an
    /// image that is already there is already the right one. It is not
    /// re-checksummed — the check belongs to the download, and re-hashing four
    /// gigabytes on every run would cost more than it protects.
    /// </remarks>
    public static async Task<string> EnsureAsync(
        HttpClient http,
        IncusOsUpdate update,
        IncusOsFile file,
        Action<string> report,
        CancellationToken ct = default)
    {
        System.IO.Directory.CreateDirectory(Directory);

        var unpacked = Path.Combine(Directory, IncusOsIndex.LocalName(update));

        if (File.Exists(unpacked))
        {
            report($"{Path.GetFileName(unpacked)} is already here");
            return unpacked;
        }

        var compressed = unpacked + ".gz";
        var location = IncusOsIndex.Location(update, file);

        report($"downloading {location.AbsoluteUri}");

        try
        {
            await FetchAsync(http, location, compressed, file.Size, report, ct).ConfigureAwait(false);

            report("checking it");
            var digest = await DigestAsync(compressed, ct).ConfigureAwait(false);

            if (!digest.Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new ImageIndexException(
                    $"{Path.GetFileName(compressed)} does not match the checksum the index published. " +
                    "The download was interrupted, or something in the middle changed it.");
            }

            report("unpacking");
            await UnpackAsync(compressed, unpacked, ct).ConfigureAwait(false);
        }
        catch
        {
            // A partial file left behind would be picked up as complete next
            // time, because the name is the whole of what identifies it.
            Delete(compressed);
            Delete(unpacked);
            throw;
        }

        Delete(compressed);

        report($"{Path.GetFileName(unpacked)} — {Size(new FileInfo(unpacked).Length)}");
        return unpacked;
    }

    private static async Task FetchAsync(
        HttpClient http,
        Uri location,
        string destination,
        long expected,
        Action<string> report,
        CancellationToken ct)
    {
        using var response = await http
            .GetAsync(location, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new ImageIndexException(
                $"{location.AbsoluteUri} answered {(int)response.StatusCode} {response.StatusCode}");
        }

        var total = response.Content.Headers.ContentLength ?? expected;

        await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var sink = File.Create(destination);

        var buffer = new byte[1 << 20];
        long done = 0;
        var announced = -1;

        int read;
        while ((read = await source.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            await sink.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            done += read;

            // Every whole percent, and never twice. A progress line per buffer
            // is four hundred lines of scrollback for one download.
            var percent = total > 0 ? (int)(done * 100 / total) : -1;

            if (percent > announced)
            {
                announced = percent;
                report($"  {percent.ToString(CultureInfo.InvariantCulture),3}%  {Size(done)} of {Size(total)}");
            }
        }
    }

    private static async Task UnpackAsync(string compressed, string destination, CancellationToken ct)
    {
        await using var source = File.OpenRead(compressed);
        await using var gzip = new GZipStream(source, CompressionMode.Decompress);
        await using var sink = File.Create(destination);

        await gzip.CopyToAsync(sink, ct).ConfigureAwait(false);
    }

    private static async Task<string> DigestAsync(string path, CancellationToken ct)
    {
        await using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(file, ct).ConfigureAwait(false));
    }

    private static void Delete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Something else has it open. It is a cache entry; the next run
            // either reuses it or fails the checksum and replaces it.
        }
    }

    /// <summary>Every build unpacked on this machine, newest name first.</summary>
    public static IReadOnlyList<string> Cached() =>
        System.IO.Directory.Exists(Directory)
            ? [.. System.IO.Directory.EnumerateFiles(Directory, "IncusOS_*.img")
                .OrderByDescending(Path.GetFileName, StringComparer.Ordinal)]
            : [];

    internal static string Size(long bytes) => bytes switch
    {
        < 1024 * 1024 => $"{(bytes / 1024.0).ToString("F0", CultureInfo.InvariantCulture)} KiB",
        < 1024L * 1024 * 1024 => $"{(bytes / (1024.0 * 1024)).ToString("F0", CultureInfo.InvariantCulture)} MiB",
        _ => $"{(bytes / (1024.0 * 1024 * 1024)).ToString("F1", CultureInfo.InvariantCulture)} GiB",
    };
}
