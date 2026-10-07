using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;
using Envmux.Tests.DockerEngine;

namespace Envmux.Tests;

public sealed class ManagedGoldenImageTests
{
    private static readonly string Image = "sha256:" + new string('a', 64);

    private static DockerBackendConfig Resolve(string? image, string? mode = "1") => new DockerBackendConfig(
        GoldenTag: "published/default:1").ResolveManaged(name => name switch
        {
            "ENVMUX_MANAGED_DOCKER" => mode,
            "ENVMUX_MANAGED_GOLDEN_IMAGE" => image,
            _ => throw new InvalidOperationException("image resolution read unrelated host configuration"),
        });

    [Fact]
    public void ManagedImageOverridesOnlyTheCurrentProcessConfig()
    {
        var original = new DockerBackendConfig(GoldenTag: "published/default:1");
        var resolved = original.ResolveManaged(name => name == "ENVMUX_MANAGED_DOCKER" ? "1" : Image);
        Assert.Equal(Image, DockerImages.GoldenReference(resolved));
        Assert.Equal("published/default:1", DockerImages.GoldenReference(original));
        Assert.Null(original.ManagedGoldenImage);
        Assert.Null(Resolve(null).ManagedGoldenImage);
        Assert.Null(Resolve("").ManagedGoldenImage);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("true")]
    public void OrdinaryInvocationsIgnoreEvenMalformedAmbientImageOverrides(string? mode)
    {
        var resolved = new DockerBackendConfig().ResolveManaged(name => name == "ENVMUX_MANAGED_DOCKER"
            ? mode : throw new InvalidOperationException("ordinary invocation read the image override"));
        Assert.Null(resolved.ManagedGoldenImage);
        Assert.Null(Resolve("arbitrary:mutable-tag", mode).ManagedGoldenImage);
    }

    [Theory]
    [InlineData("sha256:abc")]
    [InlineData("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaag")]
    [InlineData("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")]
    [InlineData(" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("registry.example/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("toolchain:latest")]
    [InlineData(" ")]
    public void ManagedImageRequiresACompleteImmutableLocalImageId(string image)
    {
        Assert.Throws<BackendException>(() => Resolve(image));
    }

    [Fact]
    public async Task MissingManagedGoldenNeverBuildsPullsOrFallsBack()
    {
        await using var engine = new FakeDockerEngine();
        var images = new DockerImages(engine, Resolve(Image));
        Assert.False(await images.HasGoldenAsync());
        await Assert.ThrowsAsync<BackendException>(() => images.BuildGoldenAsync(_ => { }));
        Assert.Empty(engine.Builds);
        Assert.Equal(0, engine.Count("Pull"));
    }

    [Fact]
    public async Task ManagedImageInspectionMustConfirmTheExactId()
    {
        await using var engine = new FakeDockerEngine();
        engine.AddImage("prepared-toolchain");
        var prepared = (await engine.ImageAsync("prepared-toolchain"))!;
        Assert.True(await new DockerImages(engine, Resolve(prepared.Id)).HasGoldenAsync());
        engine.AddImage(Image);
        await Assert.ThrowsAsync<BackendException>(() => new DockerImages(engine, Resolve(Image)).HasGoldenAsync());
    }

    [Fact]
    public async Task ManagedFeatureCachesRequireTheExactBaseAndRetainItAfterBuild()
    {
        await using var engine = new FakeDockerEngine();
        engine.AddImage("prepared-toolchain");
        var prepared = (await engine.ImageAsync("prepared-toolchain"))!;
        var images = new DockerImages(engine, Resolve(prepared.Id), new EngineExec(engine));
        var fingerprint = Features.Fingerprint("recipe-id", []);
        var reference = DockerImages.ProjectReference("fixture", fingerprint);
        engine.AddImage(reference, new Dictionary<string, string> { [DockerImages.Labels.Golden] = GoldenContext.Build });
        Assert.False(await images.HasProjectAsync("fixture", fingerprint));
        await images.BuildProjectAsync("fixture", "/src/fixture", "recipe-id", [], "fixture", _ => { });
        Assert.Equal(prepared.Id, Assert.Single(engine.Created).Create.Image);
        var project = (await engine.ImageAsync(reference))!;
        Assert.Equal(prepared.Id, project.Labels[DockerImages.Labels.GoldenImage]);
        Assert.True(await images.HasProjectAsync("fixture", fingerprint));
        Assert.False(await new DockerImages(engine, Resolve(Image)).HasProjectAsync("fixture", fingerprint));
        Assert.Empty(engine.Builds);
        Assert.Equal(0, engine.Count("Pull"));
    }

    [Fact]
    public async Task ManagedSessionsCannotAdoptAnOlderToolchain()
    {
        await using var engine = new FakeDockerEngine();
        engine.AddImage("prepared-toolchain");
        engine.AddNetwork(DockerBackend.Network);
        var prepared = (await engine.ImageAsync("prepared-toolchain"))!;
        var plan = SessionPlan.Resolve(new SessionConfig { Name = "fixture" }, Path.GetTempPath(), "base-check");
        var spec = InstanceSpec.ForSession(plan, new HostConfig(), true, DateTimeOffset.UnixEpoch);
        var config = Resolve(prepared.Id);
        var body = DockerSpec.ForInstance(spec, DockerBackend.Network, config);
        Assert.Equal(prepared.Id, body.Image);
        Assert.Equal(prepared.Id, body.Labels[DockerImages.Labels.GoldenImage]);
        await engine.CreateContainerAsync(plan.InstanceName, body);
        await using var backend = new DockerBackend(engine, config);
        Assert.NotNull(await backend.Instances.GetAsync(plan.InstanceName));
        await using var changed = new DockerBackend(engine, Resolve("sha256:" + new string('b', 64)));
        await Assert.ThrowsAsync<BackendException>(() => changed.Instances.GetAsync(plan.InstanceName));
        Assert.NotNull(engine.Container(plan.InstanceName));
    }

    [Fact]
    public void ManagedBaseChangesFeatureCacheNamesWithoutChangingProjectConfiguration()
    {
        var config = new SessionConfig { Name = "fixture" };
        var plan = SessionPlan.Resolve(config, Path.GetTempPath(), "base-check");
        var selected = plan with { ManagedGoldenImage = Image };
        var changed = plan with { ManagedGoldenImage = "sha256:" + new string('b', 64) };
        Assert.NotEqual(plan.ImageFingerprint, selected.ImageFingerprint);
        Assert.NotEqual(selected.ImageFingerprint, changed.ImageFingerprint);
        Assert.Equal(Features.Fingerprint(selected.ImageFingerprintBase, selected.Features), selected.ImageFingerprint);
        Assert.Equal(plan.Image, selected.Image);
        Assert.Null(config.Image);
    }
}
