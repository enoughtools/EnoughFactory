using Envmux.Backends.DockerEngine;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// <see cref="DockerPrune.Select"/>: every rule, on a machine with no engine —
/// and the read and the apply against the fake, once.
/// </summary>
public sealed class DockerPruneTests
{
    private const string Here = "/src/planno";

    private static readonly SweepOptions Plain = new(Here, Force: false, All: false, Images: false, GoldenBuild: "abcdef123456");

    private static bool Same(string a, string b) => a == b;

    private static ContainerSummary Container(string name, string state, params (string Key, string Value)[] labels) =>
        new(name + "-id", ["/" + name], "img", state, Labels(labels));

    private static VolumeSummary Volume(string name, params (string Key, string Value)[] labels) =>
        new(name, Labels(labels));

    private static ImageInspect Image(string reference, params (string Key, string Value)[] labels) =>
        new("sha256:" + reference.GetHashCode(StringComparison.Ordinal).ToString("x8", System.Globalization.CultureInfo.InvariantCulture), [reference], Labels(labels));

    private static Dictionary<string, string> Labels(params (string Key, string Value)[] labels) =>
        labels.ToDictionary(l => l.Key, l => l.Value, StringComparer.Ordinal);

    private static EngineContents Contents(
        IReadOnlyList<ContainerSummary>? containers = null,
        IReadOnlyList<VolumeSummary>? volumes = null,
        IReadOnlyList<ImageInspect>? images = null,
        params string[] mounted) =>
        new(containers ?? [], mounted.ToHashSet(StringComparer.Ordinal), volumes ?? [], images ?? []);

    private static readonly (string, string) Schema = (DockerSpec.Labels.Schema, "2");
    private static readonly (string, string) Project = (DockerSpec.Labels.Project, "planno");
    private static readonly (string, string) Directory = (DockerSpec.Labels.Directory, Here);
    private static readonly (string, string) IsImage = (DockerImages.Labels.Kind, DockerImages.Labels.KindImage);

    [Fact]
    public void NothingWithoutTheSchemaLabelIsEverConsidered()
    {
        var contents = Contents(
            containers: [Container("web-a", "exited", ("com.docker.compose.project", "shop")), Container("envmux-build-fake", "exited", IsImage)],
            volumes: [Volume("postgres-data"), Volume("envmux-looks-like-ours-home")],
            images: [Image("nginx:1.27-alpine"), Image("envmux-golden:000000000000")]);

        Assert.Empty(DockerPrune.Select(contents, Plain with { Images = true, Force = true, All = true }, Same));
    }

    [Fact]
    public void AnInterruptedImageBuildGoesAndARunningOneNeedsAll()
    {
        var contents = Contents(containers:
        [
            Container("envmux-build-planno-1a2b", "exited", Schema, Project, Directory, IsImage),
            Container("envmux-build-planno-3c4d", "running", Schema, Project, Directory, IsImage),

            // A session from a project image inherits the image's kind and then says it is a session.
            Container("planno-feat", "exited", Schema, Project, Directory, (DockerSpec.Labels.Session, "feat"), (DockerSpec.Labels.Kind, "session")),
        ]);

        var items = DockerPrune.Select(contents, Plain, Same);

        Assert.Equal(
            [
                new SweepItem(SweepKind.Container, "envmux-build-planno-1a2b", true, "[an image build that was interrupted]"),
                new SweepItem(SweepKind.Container, "envmux-build-planno-3c4d", false, "(an image being built — use --all)"),
            ],
            items);

        Assert.All(DockerPrune.Select(contents, Plain with { All = true }, Same), i => Assert.True(i.Remove));
    }

    [Fact]
    public void ABuildFromAnotherRepositoryIsNotThisPrunesBusiness()
    {
        var contents = Contents(containers:
        [
            Container("envmux-build-other-1a2b", "exited", Schema, (DockerSpec.Labels.Project, "other"), (DockerSpec.Labels.Directory, "/src/other"), IsImage),
        ]);

        Assert.Empty(DockerPrune.Select(contents, Plain with { Force = true, All = true }, Same));
    }

    [Fact]
    public void AVolumeNothingMountsIsKeptUntilForcedAndOneNobodyClaimsNeedsAllAsWell()
    {
        var contents = Contents(
            volumes:
            [
                Volume("planno-feat-home", Schema, Project, Directory, (DockerSpec.Labels.Session, "feat"), (DockerSpec.Labels.Branch, "envmux/feat")),
                Volume("planno-feat-work", Schema, Project, Directory, (DockerSpec.Labels.Session, "feat"), (DockerSpec.Labels.Branch, "envmux/feat")),
                Volume("planno-live-home", Schema, Project, Directory, (DockerSpec.Labels.Session, "live")),
                Volume("orphan-home", Schema, (DockerSpec.Labels.Session, "old")),
            ],
            mounted: "planno-live-home");

        var kept = DockerPrune.Select(contents, Plain, Same);

        Assert.Equal(3, kept.Count);
        Assert.All(kept, i => Assert.False(i.Remove));
        Assert.Contains("use --force)", kept[1].Note, StringComparison.Ordinal);
        Assert.Contains("[envmux/feat]", kept[1].Note, StringComparison.Ordinal);
        Assert.Contains("use --force --all", kept.Single(i => i.Name == "orphan-home").Note, StringComparison.Ordinal);

        var forced = DockerPrune.Select(contents, Plain with { Force = true }, Same);

        Assert.Equal(["planno-feat-home", "planno-feat-work"], forced.Where(i => i.Remove).Select(i => i.Name));
        Assert.False(forced.Single(i => i.Name == "orphan-home").Remove);

        var everything = DockerPrune.Select(contents, Plain with { Force = true, All = true }, Same);

        Assert.Equal(["orphan-home", "planno-feat-home", "planno-feat-work"], everything.Where(i => i.Remove).Select(i => i.Name));

        // The mounted one is never so much as mentioned.
        Assert.DoesNotContain(everything, i => i.Name == "planno-live-home");
    }

    [Fact]
    public void ImagesAreOnlyLookedAtWhenAskedAndThenOldGoldenGoesAndAToolchainWithASessionStays()
    {
        var contents = Contents(
            containers: [Container("planno-feat", "running", Schema, Project, Directory, (DockerSpec.Labels.Session, "feat"), (DockerSpec.Labels.Kind, "session"))],
            images:
            [
                Image("envmux-golden:abcdef123456", Schema, (DockerImages.Labels.Kind, "golden"), (DockerImages.Labels.Golden, "abcdef123456")),
                Image("envmux-golden:000000000000", Schema, (DockerImages.Labels.Kind, "golden"), (DockerImages.Labels.Golden, "000000000000")),
                Image("envmux-image-planno-1a2b:base", Schema, Project, Directory, IsImage),
                Image("envmux-image-other-9f9f:base", Schema, (DockerSpec.Labels.Project, "other"), (DockerSpec.Labels.Directory, "/src/other"), IsImage),
            ]);

        Assert.Empty(DockerPrune.Select(contents, Plain, Same));

        var items = DockerPrune.Select(contents, Plain with { Images = true }, Same);

        Assert.Equal(
            [
                new SweepItem(SweepKind.Image, "envmux-golden:000000000000", true, "[a golden image from an earlier build]"),
                new SweepItem(SweepKind.Image, "envmux-image-planno-1a2b:base", false, "(a session is built on it)"),
            ],
            items);

        // With the session gone the toolchain is a leftover.
        var without = DockerPrune.Select(contents with { Containers = [] }, Plain with { Images = true }, Same);
        Assert.True(without.Single(i => i.Name == "envmux-image-planno-1a2b:base").Remove);
        Assert.Equal("[toolchain]", without.Single(i => i.Name == "envmux-image-planno-1a2b:base").Note);
    }

    [Fact]
    public async Task TheReadAndTheApplyDoWhatSelectDecidedAndNoMore()
    {
        await using var engine = new FakeDockerEngine { ImagesMustExist = false };

        // Somebody's own container, mounting a volume of ours by name: that volume is in use.
        await engine.CreateContainerAsync("web-a", new ContainerCreate
        {
            Image = "nginx",
            Mounts = [new MountSpec("volume", "planno-live-home", "/data")],
        });

        engine.AddVolume("planno-live-home", Labels(Schema, Project, Directory, (DockerSpec.Labels.Session, "live")));
        engine.AddVolume("planno-gone-home", Labels(Schema, Project, Directory, (DockerSpec.Labels.Session, "gone")));
        engine.AddVolume("postgres-data");
        engine.AddImage("envmux-golden:000000000000", Labels(Schema, (DockerImages.Labels.Kind, "golden"), (DockerImages.Labels.Golden, "000000000000")));
        engine.AddImage("nginx");

        await engine.CreateContainerAsync("envmux-build-planno-1a2b", new ContainerCreate
        {
            Image = "envmux-golden:000000000000",
            Labels = Labels(Schema, Project, Directory, IsImage),
        });

        var contents = await DockerPrune.ReadAsync(engine, images: true);

        Assert.Contains("planno-live-home", contents.Mounted);
        Assert.Single(contents.Images);

        var items = DockerPrune.Select(contents, Plain with { Force = true, Images = true }, Same);
        var said = new List<string>();

        var (removed, kept) = await DockerPrune.ApplyAsync(engine, items, dryRun: false, said.Add);

        Assert.Equal(3, removed);
        Assert.Equal(0, kept);
        Assert.Null(engine.Container("envmux-build-planno-1a2b"));
        Assert.Equal(["planno-live-home", "postgres-data"], engine.VolumeNames);
        Assert.Equal(["nginx"], engine.ImageNames);
        Assert.NotNull(engine.Container("web-a"));

        // A dry run says the same and does nothing.
        said.Clear();
        engine.AddVolume("planno-gone-home", Labels(Schema, Project, Directory));
        var again = DockerPrune.Select(await DockerPrune.ReadAsync(engine, images: false), Plain with { Force = true }, Same);

        Assert.Equal((0, 0), await DockerPrune.ApplyAsync(engine, again, dryRun: true, said.Add));
        Assert.Contains(said, l => l.StartsWith("would", StringComparison.Ordinal) && l.Contains("planno-gone-home", StringComparison.Ordinal));
        Assert.Contains("planno-gone-home", engine.VolumeNames);
    }
}
