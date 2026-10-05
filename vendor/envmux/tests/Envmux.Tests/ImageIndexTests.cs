using System.Net;

using Envmux.Host;
using Envmux.Host.Windows;

namespace Envmux.Tests;

/// <summary>
/// The published image index, and the one part of reading it that is not
/// obvious.
/// </summary>
public class ImageIndexTests
{
    /// <summary>
    /// A trimmed copy of the real index, with the shapes that matter kept.
    /// </summary>
    /// <remarks>
    /// Two builds, both architectures, and the file types that sit around the
    /// one this wants — because picking the ISO, or an update payload, is the
    /// mistake this is guarding against.
    /// </remarks>
    private const string Index = """
        {"format":"1.0","updates":[
          {"format":"1.0","channels":["testing","stable"],"origin":"linuxcontainers.org",
           "published_at":"2026-08-20T13:45:03.153018619Z","severity":"high",
           "url":"/202608201218","version":"202608201218","files":[
             {"architecture":"aarch64","component":"os","filename":"aarch64/IncusOS_202608201218.img.gz",
              "sha256":"aa","size":436941303,"type":"image-raw"},
             {"architecture":"x86_64","component":"os","filename":"x86_64/IncusOS_202608201218.iso.gz",
              "sha256":"bb","size":437963076,"type":"image-iso"},
             {"architecture":"x86_64","component":"os","filename":"x86_64/IncusOS_202608201218.img.gz",
              "sha256":"cc","size":609639008,"type":"image-raw"},
             {"architecture":"x86_64","component":"os","filename":"x86_64/IncusOS_202608201218.efi.gz",
              "sha256":"dd","size":77328379,"type":"update-efi"}]},
          {"format":"1.0","channels":["testing"],"origin":"linuxcontainers.org",
           "published_at":"2026-08-22T09:00:00.000000000Z","severity":"none",
           "url":"/202608220900","version":"202608220900","files":[
             {"architecture":"x86_64","component":"os","filename":"x86_64/IncusOS_202608220900.img.gz",
              "sha256":"ee","size":609639999,"type":"image-raw"}]},
          {"format":"1.0","channels":["testing","stable"],"origin":"linuxcontainers.org",
           "published_at":"2026-08-08T00:30:03.00378509Z","severity":"high",
           "url":"/202608072311","version":"202608072311","files":[
             {"architecture":"x86_64","component":"os","filename":"x86_64/IncusOS_202608072311.img.gz",
              "sha256":"ff","size":608958753,"type":"image-raw"}]}]}
        """;

    private static async Task<IReadOnlyList<IncusOsUpdate>> ParseAsync()
    {
        using var http = new HttpClient(new Canned(Index));
        return await IncusOsIndex.FetchAsync(http);
    }

    [Fact]
    public async Task ReadsTheBuildsAndTheirChannels()
    {
        var updates = await ParseAsync();

        Assert.Equal(3, updates.Count);
        Assert.Equal("202608201218", updates[0].Version);
        Assert.True(updates[0].InChannel("stable"));
        Assert.False(updates[1].InChannel("stable"));
    }

    [Fact]
    public async Task TakesTheRawImageAndNotTheIso()
    {
        // Hyper-V will not boot the ISO — it is not a hybrid image — and
        // DiskImage reads a GPT out of a raw one. Picking the wrong file here
        // fails much later, at a partition table that is not there.
        var image = IncusOsIndex.Image((await ParseAsync())[0], "x86_64")!;

        Assert.Equal("image-raw", image.Type);
        Assert.EndsWith(".img.gz", image.Filename, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PicksTheArchitectureItIsAskedFor()
    {
        var updates = await ParseAsync();

        Assert.EndsWith("aarch64/IncusOS_202608201218.img.gz",
            IncusOsIndex.Image(updates[0], "aarch64")!.Filename, StringComparison.Ordinal);

        Assert.Null(IncusOsIndex.Image(updates[1], "aarch64"));
    }

    [Fact]
    public async Task NewestFirst()
    {
        // Ordered by publication rather than by position: the index is not
        // sorted, and the newest build in the file above is the middle one.
        var stable = IncusOsIndex.Installable(await ParseAsync(), "x86_64");

        Assert.Equal(["202608201218", "202608072311"], stable.Select(u => u.Version));
    }

    [Fact]
    public async Task ATestingBuildIsNotAStableOne()
    {
        var updates = await ParseAsync();

        Assert.DoesNotContain(
            IncusOsIndex.Installable(updates, "x86_64"),
            u => u.Version == "202608220900");

        Assert.Contains(
            IncusOsIndex.Installable(updates, "x86_64", "testing"),
            u => u.Version == "202608220900");
    }

    [Fact]
    public async Task AnArchitectureWithNoImageIsNotInstallable() =>
        Assert.Single(IncusOsIndex.Installable(await ParseAsync(), "aarch64"));

    [Fact]
    public async Task TheUrlPutsTheBuildDirectoryBetweenTheTwoHalves()
    {
        // The build's `url` and the file's `filename` are both relative, and
        // joining them the obvious way — root plus filename — is a 404 from the
        // CDN. This is the whole of what that costs.
        var update = (await ParseAsync())[0];
        var image = IncusOsIndex.Image(update, "x86_64")!;

        Assert.Equal(
            "https://images.linuxcontainers.org/os/202608201218/x86_64/IncusOS_202608201218.img.gz",
            IncusOsIndex.Location(update, image).AbsoluteUri);
    }

    [Fact]
    public async Task TheLocalNameCarriesTheBuild() =>
        Assert.Equal("IncusOS_202608201218.img", IncusOsIndex.LocalName((await ParseAsync())[0]));

    [Fact]
    public async Task SomethingThatIsNotTheIndexIsRefusedWithASentence()
    {
        using var http = new HttpClient(new Canned("<html>nope</html>"));

        var thrown = await Assert.ThrowsAsync<ImageIndexException>(() => IncusOsIndex.FetchAsync(http));
        Assert.Contains("did not parse", thrown.Message, StringComparison.Ordinal);
    }

    private static readonly string[] Architectures = ["x86_64", "aarch64"];

    [Fact]
    public void TheArchitectureIsThisMachines()
    {
        // A Hyper-V guest is the same architecture as its host; there is no
        // emulation to choose, so this is a fact rather than a question.
        Assert.Contains(IncusOsIndex.Architecture, Architectures);
    }

    /// <summary>
    /// The index as it actually is today, and the URL as the CDN actually
    /// serves it.
    /// </summary>
    /// <remarks>
    /// Skipped when there is no network, so being offline is not a red build.
    /// It is worth having anyway: the fixture above proves the parser, and only
    /// this proves the parser is still parsing the right thing. The CDN's layout
    /// is somebody else's decision and this is the thing that would notice it
    /// changing.
    /// </remarks>
    [SkippableFact]
    public async Task TheRealIndexStillHasThisShape()
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

        IReadOnlyList<IncusOsUpdate> updates;

        try
        {
            updates = await IncusOsIndex.FetchAsync(http);
        }
        catch (Exception e) when (e is ImageIndexException or HttpRequestException or TaskCanceledException)
        {
            throw new SkipException($"no network, or the index is unreachable: {e.Message}");
        }

        var stable = IncusOsIndex.Installable(updates, "x86_64");
        Assert.NotEmpty(stable);

        var image = IncusOsIndex.Image(stable[0], "x86_64")!;
        Assert.NotEmpty(image.Sha256);
        Assert.True(image.Size > 100L * 1024 * 1024, "a published image should be hundreds of megabytes");

        using var head = new HttpRequestMessage(HttpMethod.Head, IncusOsIndex.Location(stable[0], image));
        using var response = await http.SendAsync(head);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    /// <summary>An HttpClient that answers everything with one string.</summary>
    private sealed class Canned(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body),
            });
    }
}

/// <summary>
/// Choosing a range nothing else on this machine already routes.
/// </summary>
public class RangeSuggestionTests
{
    [Theory]
    [InlineData("10.100.0.0/24", "10.100.0", true)]
    [InlineData("10.100.5.0/24", "10.100.0", false)]
    [InlineData("10.100.0.0/16", "10.100.0", true)]
    [InlineData("10.100.0.0/16", "10.100.9", true)]
    [InlineData("192.168.1.0/24", "10.100.0", false)]
    [InlineData("10.0.0.0/8", "10.100.0", false)]
    public void AWiderRouteCoversMoreOfTheSpace(string routed, string candidate, bool overlaps) =>
        Assert.Equal(overlaps, WindowsNetwork.Overlaps(routed, candidate));

    [Fact]
    public void SomethingThatIsNotAPrefixIsNotAnOverlap() =>
        Assert.False(WindowsNetwork.Overlaps("not-a-route", "10.100.0"));

    [Theory]
    [InlineData("10.100.0.1/24", "10.100.0.100-10.100.0.200")]
    [InlineData("10.42.7.1/24", "10.42.7.100-10.42.7.200")]
    public void TheDhcpRangeLeavesHeadroomBelowIt(string cidr, string expected)
    {
        // Addresses between the bridge and the range start are pinned to
        // instances, which is what makes a connection string writable before an
        // instance has booted.
        Assert.Equal(expected, WindowsNetwork.DhcpFor(cidr));

        var config = new HostConfig { Cidr = cidr, DhcpRange = expected };
        Assert.Empty(config.Problems());

        // .2 through .99. A session with one service takes two of these, and
        // eight — what a range starting at .10 gave — ran out in an afternoon.
        Assert.Equal(98, config.PinnedCapacity);
    }

    [Fact]
    public void ACidrItCannotReadFallsBackRatherThanThrowing() =>
        Assert.Equal(HostConfig.DefaultDhcpRange, WindowsNetwork.DhcpFor("nonsense"));
}

/// <summary>Where envmux keeps the things a person has reason to look at.</summary>
[Collection(HostHome.Name)]
public class HostDirectoryTests
{
    [Fact]
    public void EverythingLivesUnderDotEnvmuxInTheHomeFolder()
    {
        var home = Environment.GetEnvironmentVariable("ENVMUX_HOME");

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);

            var expected = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".envmux");

            Assert.Equal(expected, HostConfig.Directory);
            Assert.Equal(Path.Combine(expected, "host.json"), HostConfig.Location);
            Assert.Equal(Path.Combine(expected, "vm"), HostConfig.VmDirectory);
            Assert.Equal(Path.Combine(expected, "images"), ImageDownload.Directory);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home);
        }
    }
}
