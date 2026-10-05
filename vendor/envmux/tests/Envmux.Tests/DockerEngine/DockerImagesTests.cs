using System.Formats.Tar;
using System.Net;
using System.Text;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Incus;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// The golden image's build context as the binary carries it: what is in it,
/// what it hashes to, and the tar the engine is handed.
/// </summary>
public sealed class GoldenContextTests
{
    [Fact]
    public void TheBinaryCarriesTheDockerfileAndWhatItCopies()
    {
        var names = GoldenContext.Files.Select(f => f.Name).ToList();

        Assert.Contains("Dockerfile", names);
        Assert.Contains("envmux-init", names);

        // Housekeeping for git is not build context, and would move the hash
        // for a reason that has nothing to do with the image.
        Assert.DoesNotContain(names, n => n.StartsWith('.') || n.Contains("/.", StringComparison.Ordinal));
    }

    [Fact]
    public void NothingInTheContextHasACarriageReturn()
    {
        foreach (var file in GoldenContext.Files)
        {
            Assert.False(file.Content.Contains((byte)'\r'), $"{file.Name} has a CR in it");
        }
    }

    [Fact]
    public void EveryFileTheDockerfileCopiesIsInTheContext()
    {
        var names = GoldenContext.Files.Select(f => f.Name).ToHashSet(StringComparer.Ordinal);

        foreach (var line in Dockerfile().Split('\n'))
        {
            var words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);

            if (words.Length < 3 || words[0] is not ("COPY" or "ADD"))
            {
                continue;
            }

            foreach (var source in words[1..^1])
            {
                Assert.Contains(source, names);
            }
        }
    }

    /// <summary>
    /// The engine is asked for its classic builder, which is a tar in and lines
    /// out; BuildKit's syntax is an error there, and only on a real engine.
    /// </summary>
    [Theory]
    [InlineData("--mount")]
    [InlineData("--chmod")]
    [InlineData("--chown=")]
    [InlineData("<<")]
    [InlineData("# syntax=")]
    public void TheDockerfileAsksNothingTheClassicBuilderCannotDo(string buildKitOnly)
    {
        var instructions = string.Join(
            '\n',
            Dockerfile().Split('\n').Where(l => !l.TrimStart().StartsWith('#') || l.StartsWith("# syntax", StringComparison.Ordinal)));

        Assert.DoesNotContain(buildKitOnly, instructions, StringComparison.Ordinal);
    }

    [Fact]
    public void TheBaseImageIsPinnedByDigest()
    {
        var from = Assert.Single(Dockerfile().Split('\n'), l => l.StartsWith("FROM ", StringComparison.Ordinal));

        Assert.Matches("^FROM [a-z0-9./:-]+@sha256:[0-9a-f]{64}$", from);
    }

    [Fact]
    public void TheImageRunsItsInitAndBakesNoHostKeys()
    {
        var dockerfile = Dockerfile();

        Assert.Contains("CMD [\"/usr/local/bin/envmux-init\"]", dockerfile, StringComparison.Ordinal);

        // In the same RUN as the install, or the keys are still in the layer below.
        var install = dockerfile[dockerfile.IndexOf("openssh-server", StringComparison.Ordinal)..];
        var endOfRun = install.IndexOf("\n\n", StringComparison.Ordinal);

        Assert.Contains("rm -f /etc/ssh/ssh_host_*", install[..endOfRun], StringComparison.Ordinal);
    }

    [Fact]
    public void TheImageHasWhatASessionAndTheBackendsPlumbingNeedAndNoMore()
    {
        var dockerfile = Dockerfile();

        foreach (var package in new[] { "tmux", "openssh-server", "git", "sudo", "curl", "bash", "socat" })
        {
            Assert.Matches($@"(?m)^\s+.*\b{package}\b", dockerfile);
        }

        // A session publishes nothing and holds no capability, so there is no
        // ingress helper to carry rules for, and no docker group to offer a
        // socket to. Their return would be a design change, not a package.
        Assert.DoesNotContain("nftables", dockerfile, StringComparison.Ordinal);
        Assert.DoesNotContain("groupadd", dockerfile, StringComparison.Ordinal);
    }

    [Fact]
    public void TheInitStartsSshdWaitsAndDoesNothingElse()
    {
        var init = Encoding.UTF8.GetString(GoldenContext.Files.Single(f => f.Name == "envmux-init").Content);

        Assert.StartsWith("#!/bin/sh\n", init, StringComparison.Ordinal);
        Assert.Contains("/usr/sbin/sshd", init, StringComparison.Ordinal);
        Assert.Contains("trap 'exit 0' TERM INT", init, StringComparison.Ordinal);
        Assert.DoesNotContain("docker.sock", init, StringComparison.Ordinal);
        Assert.DoesNotContain("socat", init, StringComparison.Ordinal);
    }

    [Fact]
    public void TheBuildIsTwelveHexAndTheSameEveryTime()
    {
        Assert.Matches("^[0-9a-f]{12}$", GoldenContext.Build);
        Assert.Equal(GoldenContext.Build, GoldenContext.BuildOf(GoldenContext.Files));
        Assert.Equal(GoldenContext.Build, GoldenContext.BuildOf([.. GoldenContext.Files.Reverse()]));
    }

    [Fact]
    public void AnEditIsANewBuildAndSoIsARename()
    {
        var files = new List<GoldenFile>
        {
            new("Dockerfile", "FROM scratch\n"u8.ToArray()),
            new("envmux-init", "#!/bin/sh\n"u8.ToArray()),
        };

        var build = GoldenContext.BuildOf(files);

        Assert.NotEqual(build, GoldenContext.BuildOf([files[0] with { Content = "FROM scratch \n"u8.ToArray() }, files[1]]));
        Assert.NotEqual(build, GoldenContext.BuildOf([files[0], files[1] with { Name = "init" }]));
        Assert.NotEqual(build, GoldenContext.BuildOf([files[0]]));
    }

    [Fact]
    public void ACheckoutWithCrlfIsTheSameBuildAsOneWithout()
    {
        var unix = GoldenContext.Normalise("envmux-init", "#!/bin/sh\nset -u\n"u8.ToArray());
        var windows = GoldenContext.Normalise("sub\\envmux-init", "#!/bin/sh\r\nset -u\r\n"u8.ToArray());

        Assert.Equal(unix.Content, windows.Content);
        Assert.Equal("sub/envmux-init", windows.Name);

        // A lone CR is somebody's data, and a file with a NUL is not text at all.
        Assert.Equal("a\rb"u8.ToArray(), GoldenContext.Normalise("x", "a\rb"u8.ToArray()).Content);
        Assert.Equal(new byte[] { 0, 13, 10 }, GoldenContext.Normalise("x", [0, 13, 10]).Content);
    }

    [Fact]
    public void TheTarHasTheDockerfileAtItsRootAndTheScriptExecutable()
    {
        var entries = Entries(GoldenContext.Tar(GoldenContext.Files));

        Assert.Equal(GoldenContext.Files.Select(f => f.Name).Order(StringComparer.Ordinal), entries.Select(e => e.Name));

        var dockerfile = entries.Single(e => e.Name == "Dockerfile");
        var init = entries.Single(e => e.Name == "envmux-init");

        Assert.Equal(Convert.ToInt32("644", 8), (int)dockerfile.Mode);
        Assert.Equal(Convert.ToInt32("755", 8), (int)init.Mode);
        Assert.All(entries, e => Assert.Equal(DateTimeOffset.UnixEpoch, e.Modified));
        Assert.Equal(GoldenContext.Files.Single(f => f.Name == "Dockerfile").Content, dockerfile.Content);
        Assert.StartsWith("#!/bin/sh\n", Encoding.UTF8.GetString(init.Content), StringComparison.Ordinal);
    }

    [Fact]
    public void TheSameFilesAreTheSameTar()
    {
        Assert.Equal(GoldenContext.Tar(GoldenContext.Files), GoldenContext.Tar([.. GoldenContext.Files.Reverse()]));
    }

    private static string Dockerfile() =>
        Encoding.UTF8.GetString(GoldenContext.Files.Single(f => f.Name == "Dockerfile").Content);

    internal static List<(string Name, UnixFileMode Mode, DateTimeOffset Modified, byte[] Content)> Entries(byte[] tar)
    {
        var entries = new List<(string, UnixFileMode, DateTimeOffset, byte[])>();

        using var reader = new TarReader(new MemoryStream(tar));

        while (reader.GetNextEntry() is { } entry)
        {
            using var content = new MemoryStream();
            entry.DataStream?.CopyTo(content);
            entries.Add((entry.Name, entry.Mode, entry.ModificationTime, content.ToArray()));
        }

        return entries;
    }
}

/// <summary>
/// <see cref="DockerImages"/> against the fake engine, with a real
/// <see cref="EngineExec"/> over it: names, labels, and the order a project's
/// image is made in.
/// </summary>
public sealed class DockerImagesTests
{
    private static readonly Feature Node = new(
        "ghcr.io", "devcontainers/features/node", "1", new Dictionary<string, string> { ["version"] = "22" });

    private static readonly Feature Dotnet = new(
        "ghcr.io", "devcontainers/features/dotnet", "2", new Dictionary<string, string>());

    [Fact]
    public void GoldenIsNamedForTheBuildUnlessTheRecordNamesAnother()
    {
        Assert.Equal($"envmux-golden:{GoldenContext.Build}", DockerImages.GoldenReference(new DockerBackendConfig()));
        Assert.Equal($"envmux-golden:{GoldenContext.Build}", DockerImages.GoldenReference(new DockerBackendConfig { GoldenTag = "  " }));

        Assert.Equal(
            "ghcr.io/somebody/envmux-golden:7",
            DockerImages.GoldenReference(new DockerBackendConfig { GoldenTag = " ghcr.io/somebody/envmux-golden:7 " }));
    }

    [Fact]
    public void AProjectsImageIsWhatTheSessionsCreationBodyNamesWithAColon()
    {
        Assert.Equal("envmux-image-planno-0a1b2c3d:base", DockerImages.ProjectReference("planno", "0a1b2c3d"));

        Assert.Equal(
            ProjectImage.Source("planno", "0a1b2c3d").Replace('/', ':'),
            DockerImages.ProjectReference("planno", "0a1b2c3d"));
    }

    [Fact]
    public async Task ThereIsNoGoldenImageUntilTheEngineHasThisBuild()
    {
        await using var engine = new FakeDockerEngine();
        var images = new DockerImages(engine, new DockerBackendConfig());

        Assert.False(await images.HasGoldenAsync());

        // The build before this one is not this one.
        engine.AddImage("envmux-golden:000000000000");
        Assert.False(await images.HasGoldenAsync());

        engine.AddImage(DockerImages.GoldenReference(new DockerBackendConfig()));
        Assert.True(await images.HasGoldenAsync());
    }

    [Fact]
    public async Task BuildingGoldenHandsTheEngineTheContextTheTagAndTheLabels()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();

        var images = new DockerImages(engine, new DockerBackendConfig())
        {
            Prefix = "swarmtest-",
            ExtraLabels = new Dictionary<string, string> { ["envmux.swarmtest"] = "1" },
        };

        await images.BuildGoldenAsync(said.Add);

        var build = Assert.Single(engine.Builds);

        Assert.Equal($"swarmtest-golden:{GoldenContext.Build}", build.Tag);
        Assert.Equal(images.GoldenImage, build.Tag);

        Assert.Equal(
            new Dictionary<string, string>
            {
                ["envmux.schema"] = InstanceSpec.Keys.SchemaVersion,
                ["envmux.kind"] = "golden",
                ["envmux.golden"] = GoldenContext.Build,
                ["envmux.swarmtest"] = "1",
            },
            build.Labels);

        Assert.Equal(
            ["Dockerfile", "envmux-init"],
            GoldenContextTests.Entries(build.Context).Select(e => e.Name));

        // Said once, before the builder starts talking: this may be minutes.
        Assert.Single(said, l => l.Contains("minutes", StringComparison.Ordinal));
        Assert.Contains("minutes", said[0], StringComparison.Ordinal);

        // And the builder's own lines come through as they are.
        Assert.Contains(said, l => l.StartsWith("Step 1/1", StringComparison.Ordinal));
        Assert.Equal(0, engine.Count("Pull"));
        Assert.True(await images.HasGoldenAsync());
    }

    [Fact]
    public async Task APublishedGoldenImageIsPulledAndNeverBuilt()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();
        var images = new DockerImages(engine, new DockerBackendConfig { GoldenTag = "ghcr.io/somebody/envmux-golden:7" });

        Assert.False(await images.HasGoldenAsync());

        await images.BuildGoldenAsync(said.Add);

        Assert.Empty(engine.Builds);
        Assert.Equal(1, engine.Count("Pull"));
        Assert.Contains("ghcr.io/somebody/envmux-golden:7", engine.ImageNames);
        Assert.True(await images.HasGoldenAsync());
        Assert.DoesNotContain(said, l => l.Contains("minutes", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AProjectsImageMadeOnAnotherGoldenBuildIsNotThisProjectsImage()
    {
        await using var engine = new FakeDockerEngine();
        var images = new DockerImages(engine, new DockerBackendConfig());
        var reference = DockerImages.ProjectReference("planno", "0a1b2c3d");

        Assert.False(await images.HasProjectAsync("planno", "0a1b2c3d"));

        engine.AddImage(reference, new Dictionary<string, string> { ["envmux.golden"] = GoldenContext.Build });
        Assert.True(await images.HasProjectAsync("planno", "0a1b2c3d"));
        Assert.False(await images.HasProjectAsync("planno", "ffffffff"));

        await engine.RemoveImageAsync(reference);
        engine.AddImage(reference, new Dictionary<string, string> { ["envmux.golden"] = "000000000000" });
        Assert.False(await images.HasProjectAsync("planno", "0a1b2c3d"));

        // One that does not say is taken as it is, and so is any when golden is
        // a published image with no build of this binary's to compare with.
        var published = new DockerImages(engine, new DockerBackendConfig { GoldenTag = "somebody/golden:1" });
        Assert.True(await published.HasProjectAsync("planno", "0a1b2c3d"));

        await engine.RemoveImageAsync(reference);
        engine.AddImage(reference);
        Assert.True(await images.HasProjectAsync("planno", "0a1b2c3d"));
    }

    [Fact]
    public async Task WithoutAnExecItSaysItCannotBuildAProjectsImage()
    {
        await using var engine = new FakeDockerEngine();
        var images = new DockerImages(engine, new DockerBackendConfig());

        Assert.False(images.CanBuildProject);

        await Assert.ThrowsAsync<BackendException>(() =>
            images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node], "matt", _ => { }));
    }

    [Fact]
    public async Task AProjectsImageIsGoldenPlusEveryFeatureCommitted()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();
        var images = Images(engine);

        engine.AddImage(images.GoldenImage, new Dictionary<string, string> { ["envmux.golden"] = GoldenContext.Build });

        Assert.True(images.CanBuildProject);

        await images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node, Dotnet], "matt", said.Add);

        var fingerprint = Features.Fingerprint("debian/13", [Node, Dotnet]);
        var container = $"envmux-build-planno-{fingerprint}";

        // Golden was there, so nothing was built or pulled to get it.
        Assert.Empty(engine.Builds);

        // Created from golden with nothing of its own: a commit keeps the
        // container's command and environment as the image's.
        var (createdName, created) = Assert.Single(engine.Created);
        Assert.Equal(container, createdName);
        Assert.Equal(images.GoldenImage, created.Image);
        Assert.Null(created.Cmd);
        Assert.Null(created.Entrypoint);
        Assert.Null(created.User);
        Assert.Empty(created.Env);
        Assert.Empty(created.Ports);
        Assert.Empty(created.Mounts);

        // Each feature, in order, as root, through sh -c — then the host keys go.
        var execs = engine.AllExecs;
        Assert.Equal(3, execs.Count);
        Assert.All(execs, e => Assert.Equal(container, e.Container));
        Assert.All(execs, e => Assert.Equal(["sh", "-c"], e.Create.Cmd.Take(2)));
        Assert.All(execs, e => Assert.Equal("0:0", e.Create.User));
        Assert.Contains("devcontainers/features/node", execs[0].Create.Cmd[2], StringComparison.Ordinal);
        Assert.Contains("export _REMOTE_USER='matt'", execs[0].Create.Cmd[2], StringComparison.Ordinal);
        Assert.Contains("devcontainers/features/dotnet", execs[1].Create.Cmd[2], StringComparison.Ordinal);
        Assert.Equal("rm -rf /home/.envmux", execs[2].Create.Cmd[2]);
        Assert.Equal("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", execs[0].Create.Env!["PATH"]);

        // Nothing was stopped or committed until the last exec had run.
        var order = engine.Calls.Select(c => c.Operation).Where(o => o is "Start" or "ExecCreate" or "Stop" or "Commit" or "Remove").ToList();
        Assert.Equal(["Start", "ExecCreate", "ExecCreate", "ExecCreate", "Stop", "Commit", "Remove"], order);

        // The image is there under the name a session's creation body gives it,
        // the container is not, and the labels say whose it is.
        var image = await engine.ImageAsync(DockerImages.ProjectReference("planno", fingerprint));

        Assert.NotNull(image);
        Assert.Null(engine.Container(container));
        Assert.True(await images.HasProjectAsync("planno", fingerprint));

        Assert.Equal(
            new Dictionary<string, string>
            {
                ["envmux.schema"] = InstanceSpec.Keys.SchemaVersion,
                ["envmux.kind"] = "image",
                ["envmux.project"] = "planno",
                ["envmux.directory"] = "/src/planno",
                ["envmux.image"] = fingerprint,
                ["envmux.created"] = "1789000000",
                ["envmux.golden"] = GoldenContext.Build,
            },
            image.Labels);

        Assert.Contains(said, l => l.Contains("installing node (1 of 2)", StringComparison.Ordinal));
        Assert.Contains(said, l => l.Contains("installing dotnet (2 of 2)", StringComparison.Ordinal));
        Assert.Contains("ready", said[^1], StringComparison.Ordinal);
    }

    [Fact]
    public async Task WithNoGoldenImageItBuildsOneFirstAndSaysSo()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();
        var images = Images(engine);

        await images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node], "matt", said.Add);

        Assert.Equal(images.GoldenImage, Assert.Single(engine.Builds).Tag);
        Assert.Contains(said, l => l.Contains("no golden image", StringComparison.Ordinal));
        Assert.True(await images.HasProjectAsync("planno", Features.Fingerprint("debian/13", [Node])));
    }

    [Fact]
    public async Task AFeatureThatFailsIsNamedAndNothingIsLeftBehind()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();

        engine.OnExec = exec => exec.CommandLine.Contains("features/dotnet", StringComparison.Ordinal)
            ? new FakeExecResult(1, "one\ntwo\n", "dotnet-install: no such version\n")
            : new FakeExecResult(0);

        var images = Images(engine);
        engine.AddImage(images.GoldenImage);

        var e = await Assert.ThrowsAsync<BackendException>(() =>
            images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node, Dotnet], "matt", said.Add));

        Assert.Contains("ghcr.io/devcontainers/features/dotnet:2", e.Message, StringComparison.Ordinal);
        Assert.Contains("no such version", e.Message, StringComparison.Ordinal);

        Assert.Empty(engine.AllContainers);
        Assert.Equal(0, engine.Count("Commit"));
        Assert.False(await images.HasProjectAsync("planno", Features.Fingerprint("debian/13", [Node, Dotnet])));
        Assert.Contains("removing what was half-built", said);
    }

    [Fact]
    public async Task HostKeysThatWillNotGoFailTheBuildRatherThanShipInTheImage()
    {
        await using var engine = new FakeDockerEngine();

        engine.OnExec = exec => exec.CommandLine.Contains("rm -rf", StringComparison.Ordinal)
            ? new FakeExecResult(1, "", "rm: cannot remove '/home/.envmux': Device or resource busy")
            : new FakeExecResult(0);

        var images = Images(engine);
        engine.AddImage(images.GoldenImage);

        var e = await Assert.ThrowsAsync<BackendException>(() =>
            images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node], "matt", _ => { }));

        Assert.Contains("host keys", e.Message, StringComparison.Ordinal);
        Assert.Equal(0, engine.Count("Commit"));
        Assert.Empty(engine.AllContainers);
    }

    [Fact]
    public async Task AnInterruptedBuildsContainerIsRemovedBeforeTheNextOne()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();
        var images = Images(engine);
        var fingerprint = Features.Fingerprint("debian/13", [Node]);

        engine.AddImage(images.GoldenImage);

        var leftover = await engine.CreateContainerAsync(
            $"envmux-build-planno-{fingerprint}", new ContainerCreate { Image = images.GoldenImage });
        await engine.StartAsync(leftover);

        await images.BuildProjectAsync("planno", "/src/planno", "debian/13", [Node], "matt", said.Add);

        Assert.Contains("removing a half-built image from an earlier attempt", said);
        Assert.Empty(engine.AllContainers);
        Assert.True(await images.HasProjectAsync("planno", fingerprint));
    }

    [Fact]
    public async Task ADockerFeatureIsInstalledAndToldTheTruthAboutDaemons()
    {
        await using var engine = new FakeDockerEngine();
        var said = new List<string>();
        var images = Images(engine);
        engine.AddImage(images.GoldenImage);

        var docker = new Feature("ghcr.io", "devcontainers/features/docker-in-docker", "2", new Dictionary<string, string>());

        await images.BuildProjectAsync("planno", "/src/planno", "debian/13", [docker], "matt", said.Add);

        Assert.Contains(said, l => l.Contains("cannot run a Docker daemon", StringComparison.Ordinal));
    }

    private static DockerImages Images(FakeDockerEngine engine) =>
        new(engine, new DockerBackendConfig(), new EngineExec(engine))
        {
            Registry = new NoRegistry(),
            Now = () => DateTimeOffset.FromUnixTimeSeconds(1789000000),
        };

    /// <summary>A feature registry that is not there, so a unit test never touches the network.</summary>
    private sealed class NoRegistry : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}
