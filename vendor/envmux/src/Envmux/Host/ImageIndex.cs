using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Host;

/// <summary>The image index could not be fetched, or held nothing usable.</summary>
internal sealed class ImageIndexException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>One file belonging to a published IncusOS build.</summary>
/// <param name="Architecture">"x86_64", "aarch64", or empty for the architecture-independent ones.</param>
/// <param name="Filename">Relative to the build's own directory.</param>
/// <param name="Sha256">Of the file as published — which is to say, compressed.</param>
/// <param name="Size">Likewise: the compressed size.</param>
/// <param name="Type">"image-raw" is the one this wants. See <see cref="IncusOsIndex.RawImage"/>.</param>
internal sealed record IncusOsFile(
    string Architecture,
    string Component,
    string Filename,
    string Sha256,
    long Size,
    string Type);

/// <summary>One published build, in one or more channels.</summary>
internal sealed record IncusOsUpdate
{
    /// <summary>A timestamp — <c>202608201218</c> — which sorts chronologically as a string.</summary>
    public string Version { get; set; } = "";

    /// <summary>"stable", "testing", or both.</summary>
    public IReadOnlyList<string> Channels { get; set; } = [];

    public string Severity { get; set; } = "";

    public string PublishedAt { get; set; } = "";

    /// <summary>The build's own directory, relative to the index — <c>/202608201218</c>.</summary>
    public string Url { get; set; } = "";

    public IReadOnlyList<IncusOsFile> Files { get; set; } = [];

    public bool InChannel(string channel) =>
        Channels.Contains(channel, StringComparer.OrdinalIgnoreCase);

    /// <summary>When it was published, or the epoch if the field is unreadable.</summary>
    public DateTimeOffset When =>
        DateTimeOffset.TryParse(PublishedAt, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal, out var when)
            ? when
            : DateTimeOffset.UnixEpoch;

    /// <summary>How this reads in a list somebody is choosing from.</summary>
    public string Describe(string architecture)
    {
        var image = Files.FirstOrDefault(f =>
            f.Type == IncusOsIndex.RawImage &&
            f.Architecture.Equals(architecture, StringComparison.OrdinalIgnoreCase));

        var size = image is null
            ? ""
            : $"  {(image.Size / (1024.0 * 1024)).ToString("F0", CultureInfo.InvariantCulture)} MiB";

        return $"{Version}  {When:yyyy-MM-dd}  {string.Join("/", Channels)}{size}";
    }
}

/// <summary>
/// What IncusOS has published, and which build to install.
/// </summary>
/// <remarks>
/// <para>
/// The index is one JSON document listing every build and every file in it. The
/// one this wants is <c>image-raw</c>: Hyper-V will not boot the ISO, and
/// <see cref="DiskImage"/> reads a GPT out of a raw image to find where the seed
/// goes.
/// </para>
/// <para>
/// Fetched rather than pinned. A version written into this repository would be
/// stale within the month — IncusOS publishes on a cadence of weeks — and the
/// wrong answer would be an install of something two releases old for no reason
/// anybody chose.
/// </para>
/// </remarks>
internal static class IncusOsIndex
{
    /// <summary>Where the index lives, and what every file path is relative to.</summary>
    public const string Root = "https://images.linuxcontainers.org/os";

    public const string IndexPath = "/index.json";

    /// <summary>
    /// The file type Hyper-V needs.
    /// </summary>
    /// <remarks>
    /// Not <c>image-iso</c>. The ISO is not a hybrid image and Hyper-V will not
    /// boot it, which the IncusOS documentation says in one sentence that is
    /// easy to read past.
    /// </remarks>
    public const string RawImage = "image-raw";

    public const string Stable = "stable";

    private static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// The architecture to install, which is this machine's.
    /// </summary>
    /// <remarks>
    /// A Hyper-V guest is the same architecture as its host; there is no
    /// emulation to choose. So this is a fact rather than a preference, and the
    /// wizard does not ask.
    /// </remarks>
    public static string Architecture => RuntimeInformation.OSArchitecture switch
    {
        System.Runtime.InteropServices.Architecture.Arm64 => "aarch64",
        _ => "x86_64",
    };

    /// <summary>Fetch and parse the index.</summary>
    public static async Task<IReadOnlyList<IncusOsUpdate>> FetchAsync(
        HttpClient http,
        CancellationToken ct = default)
    {
        string json;

        try
        {
            json = await http.GetStringAsync($"{Root}{IndexPath}", ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            throw new ImageIndexException(
                $"could not reach {Root}{IndexPath}: {e.Message}. " +
                "Pass --image with a file you already have and this step is skipped.", e);
        }

        try
        {
            var index = WireJson.Deserialize<Index>(json, Options);

            return index?.Updates ?? throw new ImageIndexException("the image index is empty");
        }
        catch (JsonException e)
        {
            throw new ImageIndexException($"the image index did not parse: {e.Message}", e);
        }
    }

    /// <summary>
    /// Every build that has an installable image for this architecture, newest first.
    /// </summary>
    public static IReadOnlyList<IncusOsUpdate> Installable(
        IReadOnlyList<IncusOsUpdate> updates,
        string architecture,
        string? channel = Stable) =>
    [
        .. updates
            .Where(u => channel is null || u.InChannel(channel))
            .Where(u => Image(u, architecture) is not null)
            .OrderByDescending(u => u.When)
            .ThenByDescending(u => u.Version, StringComparer.Ordinal),
    ];

    /// <summary>The raw image for an architecture within one build, if it has one.</summary>
    public static IncusOsFile? Image(IncusOsUpdate update, string architecture) =>
        update.Files.FirstOrDefault(f =>
            f.Type.Equals(RawImage, StringComparison.Ordinal) &&
            f.Architecture.Equals(architecture, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Where a file actually is.
    /// </summary>
    /// <remarks>
    /// The build's <c>url</c> and the file's <c>filename</c> are both relative,
    /// and joining them the obvious way — root plus filename — produces a 404.
    /// The build directory sits between them.
    /// </remarks>
    public static Uri Location(IncusOsUpdate update, IncusOsFile file) =>
        new($"{Root}{update.Url.TrimEnd('/')}/{file.Filename.TrimStart('/')}");

    /// <summary>What the local copy of a build is called, once it is unpacked.</summary>
    public static string LocalName(IncusOsUpdate update) => $"IncusOS_{update.Version}.img";

    internal sealed record Index
    {
        public string Format { get; set; } = "";

        public IReadOnlyList<IncusOsUpdate> Updates { get; set; } = [];
    }
}
