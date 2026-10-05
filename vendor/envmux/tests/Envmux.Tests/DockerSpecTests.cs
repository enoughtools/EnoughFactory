using System.Text.RegularExpressions;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// A session, as the container a Docker engine is told to create — built from
/// what <see cref="InstanceSpec"/> really produces, so that a change there is a
/// failure here rather than a session that runs the wrong image.
/// </summary>
public sealed class DockerSpecTests
{
    private const string Network = "envmux-net-proj-sess";

    private static readonly DockerBackendConfig Config = new() { GoldenTag = "envmux-golden:test" };

    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);

    private static readonly string Directory = Path.Combine(Path.GetTempPath(), "envmux-dockerspec-nowhere");

    private static SessionPlan Plan(Dictionary<string, ServiceConfig>? services = null) =>
        SessionPlan.Resolve(
            new SessionConfig
            {
                Name = "proj",
                Domain = "envmux",
                Workdir = "/src",
                Routes = new Dictionary<string, RouteConfig> { ["web"] = 5173, ["api"] = 3000 },
                Services = services ?? new Dictionary<string, ServiceConfig>
                {
                    ["db"] = new ServiceConfig { Type = "postgres", Password = "pw" },
                },
            },
            Directory,
            "sess");

    private static InstancesPost SessionSpec(SessionPlan? plan = null, string? copyFrom = null, bool golden = true) =>
        InstanceSpec.ForSession(plan ?? Plan(), new HostConfig(), golden, Now, address: null, copyFrom);

    private static InstancesPost ServiceSpec(SessionPlan plan) =>
        InstanceSpec.ForService(plan.Services.Single(), plan, new HostConfig(), Now);

    /// <summary>The same body, with keys added — the ones this backend reads that <see cref="InstanceSpec"/> does not write yet.</summary>
    private static InstancesPost With(InstancesPost spec, params (string Key, string Value)[] extra)
    {
        var config = new Dictionary<string, string>(spec.Config ?? new Dictionary<string, string>(StringComparer.Ordinal), StringComparer.Ordinal);

        foreach (var (key, value) in extra)
        {
            config[key] = value;
        }

        return spec with { Config = config };
    }

    [Fact]
    public void ASessionIsTheGoldenImageOnTheSessionsNetworkPublishingNothing()
    {
        var container = DockerSpec.ForInstance(SessionSpec(), Network, Config);

        Assert.Equal("envmux-golden:test", container.Image);
        Assert.Equal("proj-sess", container.Hostname);
        Assert.True(container.Init);
        Assert.False(container.Tty);

        // Root, and run as the image says: its init is what starts sshd, and
        // the bootstrap makes the account over exec.
        Assert.Null(container.User);
        Assert.Null(container.Entrypoint);
        Assert.Null(container.Cmd);
        Assert.Null(container.WorkingDir);

        // Nothing on the workstation: the browser's relay is the way in.
        Assert.Empty(container.Ports);

        Assert.Equal(
            [
                new MountSpec("volume", "proj-sess-home", "/home"),
                new MountSpec("volume", "proj-sess-work", SessionConfig.DefaultWorkdir),
            ],
            container.Mounts);

        Assert.Equal(Network, container.Network);
        Assert.Null(container.NetworkMode);
        Assert.Equal(["proj-sess", "session"], container.NetworkAliases);
        Assert.Equal(["host.docker.internal:host-gateway"], container.ExtraHosts);

        Assert.Empty(container.Env);
        Assert.Empty(container.CapAdd);
        Assert.Empty(container.SecurityOpt);
        Assert.Empty(container.Sysctls);
        Assert.Empty(container.GroupAdd);
        Assert.False(container.AutoRemove);
        Assert.Null(container.MemoryBytes);
        Assert.Null(container.NanoCpus);

        Assert.Empty(DockerSpec.Problems(container));
    }

    [Fact]
    public void ASessionsLabelsAreTheIncusKeysWithoutTheirPrefixAndWhatItIs()
    {
        var plan = Plan();
        var labels = DockerSpec.ForInstance(SessionSpec(plan), Network, Config).Labels;

        var expected = new Dictionary<string, string>
        {
            [DockerSpec.Labels.Schema] = InstanceSpec.Keys.SchemaVersion,
            [DockerSpec.Labels.Project] = "proj",
            [DockerSpec.Labels.Session] = "sess",
            [DockerSpec.Labels.Directory] = plan.Directory,
            [DockerSpec.Labels.Branch] = plan.Branch,
            [DockerSpec.Labels.Created] = "1800000000",
            [DockerSpec.Labels.Image] = plan.ImageFingerprint,
            [DockerSpec.Labels.Kind] = "session",
            [DockerSpec.Labels.Instance] = "proj-sess",
        };

        foreach (var (key, value) in expected)
        {
            Assert.True(labels.ContainsKey(key), $"no label {key}");
            Assert.Equal(value, labels[key]);
        }

        // Those, the body, and nothing else: not a service, and no environment.
        Assert.Equal(
            expected.Keys.Append(DockerSpec.Labels.Spec).Order(StringComparer.Ordinal),
            labels.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void TheLabelNamesAreTheIncusKeysWithUserTakenOff()
    {
        // They are a wire format: changing one orphans everything already on an engine.
        Assert.Equal("envmux.schema", DockerSpec.Labels.Schema);
        Assert.Equal("envmux.project", DockerSpec.Labels.Project);
        Assert.Equal("envmux.session", DockerSpec.Labels.Session);
        Assert.Equal("envmux.service", DockerSpec.Labels.Service);
        Assert.Equal("envmux.kind", DockerSpec.Labels.Kind);
        Assert.Equal("envmux.spec", DockerSpec.Labels.Spec);

        foreach (var (incus, docker) in new[]
        {
            (InstanceSpec.Keys.Schema, DockerSpec.Labels.Schema),
            (InstanceSpec.Keys.Project, DockerSpec.Labels.Project),
            (InstanceSpec.Keys.Session, DockerSpec.Labels.Session),
            (InstanceSpec.Keys.Service, DockerSpec.Labels.Service),
            (InstanceSpec.Keys.Directory, DockerSpec.Labels.Directory),
            (InstanceSpec.Keys.Branch, DockerSpec.Labels.Branch),
            (InstanceSpec.Keys.Created, DockerSpec.Labels.Created),
            (InstanceSpec.Keys.Image, DockerSpec.Labels.Image),
            (DockerSpec.Keys.Workdir, DockerSpec.Labels.Workdir),
            (DockerSpec.Keys.Data, DockerSpec.Labels.Data),
            (DockerSpec.Keys.Host, DockerSpec.Labels.Host),
        })
        {
            Assert.Equal(incus, "user." + docker);
            Assert.Equal(docker, DockerSpec.LabelOf(incus));
        }

        Assert.Equal("limits.cpu", DockerSpec.LabelOf("limits.cpu"));
    }

    [Fact]
    public void AServiceIsItsOwnImageOnTheSessionsNetworkAnsweringToItsName()
    {
        var plan = Plan();
        var db = plan.Services.Single();

        var container = DockerSpec.ForInstance(ServiceSpec(plan), Network, Config);

        Assert.Equal("postgres:17-alpine", container.Image);
        Assert.Equal("proj-sess-db", container.Hostname);

        // As published: its own entrypoint, its own command, its own user.
        Assert.Null(container.Cmd);
        Assert.Null(container.Entrypoint);
        Assert.Null(container.User);
        Assert.True(container.Init);
        Assert.Empty(container.Ports);

        // The session reaches it at db:5432.
        Assert.Equal(Network, container.Network);
        Assert.Equal(["proj-sess-db", "db"], container.NetworkAliases);

        Assert.Equal(
            new Dictionary<string, string>
            {
                ["POSTGRES_USER"] = db.User,
                ["POSTGRES_PASSWORD"] = "pw",
                ["POSTGRES_DB"] = db.Database,
            },
            container.Env);

        // Without a data key there is no volume to name; with one, there is.
        Assert.Empty(container.Mounts);
        Assert.Equal(["host.docker.internal:host-gateway"], container.ExtraHosts);

        // Whatever the image's own labels said it was, the container says what it is.
        Assert.Equal("service", container.Labels[DockerSpec.Labels.Kind]);
        Assert.Equal("db", container.Labels[DockerSpec.Labels.Service]);
        Assert.Equal("proj", container.Labels[DockerSpec.Labels.Project]);
        Assert.Equal("sess", container.Labels[DockerSpec.Labels.Session]);
        Assert.Equal("proj-sess-db", container.Labels[DockerSpec.Labels.Instance]);

        // The password is the container's environment and is in the kept body,
        // as it is in an Incus instance's config. It is not a label of its own.
        Assert.DoesNotContain(container.Labels.Keys, k => k.Contains("POSTGRES", StringComparison.Ordinal));

        Assert.Empty(DockerSpec.Problems(container));
    }

    [Fact]
    public void TheKeysThisBackendReadsAheadOfInstanceSpecShapeTheVolumesAndTheAliases()
    {
        var plan = Plan();

        var session = With(SessionSpec(plan), (DockerSpec.Keys.Workdir, "/src"), (DockerSpec.Keys.Host, "proj-sess.envmux"));
        var container = DockerSpec.ForInstance(session, Network, Config);

        Assert.Equal(new MountSpec("volume", "proj-sess-work", "/src"), container.Mounts[1]);
        Assert.Equal(["proj-sess", "session", "proj-sess.envmux"], container.NetworkAliases);
        Assert.Equal("/src", container.Labels[DockerSpec.Labels.Workdir]);
        Assert.Equal("proj-sess.envmux", container.Labels[DockerSpec.Labels.Host]);

        var service = With(ServiceSpec(plan), (DockerSpec.Keys.Data, "/var/lib/postgresql/data"), (DockerSpec.Keys.Host, "proj-sess-db.envmux"));
        var db = DockerSpec.ForInstance(service, Network, Config);

        Assert.Equal([new MountSpec("volume", "proj-sess-db-data", "/var/lib/postgresql/data")], db.Mounts);
        Assert.Equal(["proj-sess-db", "db", "proj-sess-db.envmux"], db.NetworkAliases);
        Assert.Equal(["proj-sess-db-data"], DockerSpec.VolumesFor(service));
    }

    [Fact]
    public void AServiceWrittenOddlyAnswersToBothSpellings()
    {
        var plan = Plan(new Dictionary<string, ServiceConfig>
        {
            ["Mail_Hog"] = new ServiceConfig { Type = "container", Image = "mailhog/mailhog", Port = 8025 },
        });

        var container = DockerSpec.ForInstance(ServiceSpec(plan), Network, Config);

        Assert.Equal("mailhog/mailhog:latest", container.Image);
        Assert.Empty(container.Mounts);
        Assert.Equal(["proj-sess-mail-hog", "mail-hog", "Mail_Hog"], container.NetworkAliases);
    }

    [Theory]
    [InlineData("postgres:17", "https://docker.io", "postgres:17")]
    [InlineData("redis", "https://docker.io", "redis:latest")]
    [InlineData("  redis  ", null, "redis:latest")]
    [InlineData("bitnami/redis", "https://docker.io", "bitnami/redis:latest")]
    [InlineData("docker.io/library/postgres:17", "https://docker.io", "postgres:17")]
    [InlineData("docker.io/bitnami/redis", "https://docker.io", "bitnami/redis:latest")]
    [InlineData("ghcr.io/org/img", "https://docker.io", "ghcr.io/org/img:latest")]
    [InlineData("localhost:5000/img", "https://docker.io", "localhost:5000/img:latest")]
    [InlineData("localhost:5000/img:2", "https://docker.io", "localhost:5000/img:2")]
    [InlineData("org/img:1", "https://ghcr.io", "ghcr.io/org/img:1")]
    [InlineData("img", "https://registry.example:5443", "registry.example:5443/img:latest")]
    [InlineData("postgres@sha256:0123", "https://docker.io", "postgres@sha256:0123")]
    public void AServicesImageIsSaidInFullSoAPullIsOfOneTag(string alias, string? server, string expected)
    {
        var spec = ServiceSpec(Plan());

        spec = spec with { Source = spec.Source with { Alias = alias, Server = server } };

        Assert.Equal(expected, DockerSpec.ImageFor(spec, Config));
        Assert.Equal(expected, DockerSpec.Normalise(alias, server));
    }

    [Fact]
    public void ASessionCopiedFromAProjectImageRunsThatImage()
    {
        var spec = SessionSpec(copyFrom: ProjectImage.Source("proj", "1a2b3c4d"));

        Assert.Equal("envmux-image-proj-1a2b3c4d:base", DockerSpec.ImageFor(spec, Config));
        Assert.Equal(DockerImages.ProjectReference("proj", "1a2b3c4d"), DockerSpec.ImageFor(spec, Config));
        Assert.Equal("envmux-image-proj-1a2b3c4d:base", DockerSpec.ForInstance(spec, Network, Config).Image);
    }

    [Fact]
    public void ASessionThatWouldHavePulledASystemContainerImageRunsTheGoldenOneInstead()
    {
        // No golden snapshot, on Incus, means a simplestreams pull of
        // debian/13/cloud — which names nothing a Docker engine can run.
        var spec = SessionSpec(golden: false);

        Assert.Equal("image", spec.Source.Type);
        Assert.Equal("envmux-golden:test", DockerSpec.ImageFor(spec, Config));
    }

    [Fact]
    public void ARecordThatNamesNoGoldenImageGetsThisBuilds()
    {
        Assert.Equal($"envmux-golden:{GoldenContext.Build}", DockerSpec.ImageFor(SessionSpec(), new DockerBackendConfig()));
    }

    [Fact]
    public void TheBodyComesBackFromTheLabelsAloneAndMakesTheSameContainer()
    {
        var plan = Plan();
        var spec = With(ServiceSpec(plan), (DockerSpec.Keys.Data, "/var/lib/postgresql/data"));
        var labels = DockerSpec.ForInstance(spec, Network, Config).Labels;

        var read = DockerSpec.SpecOf(labels);

        Assert.NotNull(read);
        Assert.Equal(spec.Name, read.Name);
        Assert.Equal(spec.Description, read.Description);
        Assert.Equal(spec.Source, read.Source);
        Assert.Equal(spec.Config, read.Config);

        // Including what ServicePlan.AsCreated reads a kept service's password from.
        Assert.Equal("pw", read.Config!["environment.POSTGRES_PASSWORD"]);

        var again = DockerSpec.ForInstance(read, Network, Config);
        Assert.Equal(labels, again.Labels);
        Assert.Equal(DockerSpec.ForInstance(spec, Network, Config).Mounts, again.Mounts);
    }

    [Fact]
    public void LabelsThatAreNotOursGiveNothingBack()
    {
        Assert.Null(DockerSpec.SpecOf(new Dictionary<string, string>()));
        Assert.Null(DockerSpec.SpecOf(new Dictionary<string, string> { [DockerSpec.Labels.Spec] = "{ not json" }));
        Assert.Null(DockerSpec.SpecOf(new Dictionary<string, string> { [DockerSpec.Labels.Spec] = "" }));
    }

    [Fact]
    public void ASessionThatDeclaresNothingIsStillTwoVolumesOnTheDefaultWorkdir()
    {
        var plan = SessionPlan.Resolve(new SessionConfig { Name = "bare" }, Directory, "s");
        var container = DockerSpec.ForInstance(SessionSpec(plan), Network, Config);

        Assert.Empty(container.Ports);
        Assert.Equal(new MountSpec("volume", "bare-s-work", SessionConfig.DefaultWorkdir), container.Mounts[1]);
    }

    [Fact]
    public void TheEnvironmentKeysOfTheBodyAreTheContainersEnvironment()
    {
        var spec = With(SessionSpec(), ("environment.FOO", "bar=baz"), ("environment.EMPTY", ""), ("environment.", "nameless"));

        var container = DockerSpec.ForInstance(spec, Network, Config);

        Assert.Equal(new Dictionary<string, string> { ["FOO"] = "bar=baz", ["EMPTY"] = "" }, container.Env);
        Assert.DoesNotContain(container.Labels.Keys, k => k.Contains("FOO", StringComparison.Ordinal));
    }

    [Fact]
    public void LimitsInTheBodyHoldTheContainerToThem()
    {
        var container = DockerSpec.ForInstance(With(SessionSpec(), ("limits.memory", "2GiB"), ("limits.cpu", "4")), Network, Config);

        Assert.Equal(2L * 1024 * 1024 * 1024, container.MemoryBytes);
        Assert.Equal(4_000_000_000L, container.NanoCpus);

        // Pinned cores are not guessed at.
        Assert.Null(DockerSpec.ForInstance(With(SessionSpec(), ("limits.cpu", "0-3")), Network, Config).NanoCpus);
    }

    [Theory]
    [InlineData("512MiB", 536_870_912L)]
    [InlineData("1GB", 1_000_000_000L)]
    [InlineData("1048576", 1_048_576L)]
    [InlineData("64 MB", 64_000_000L)]
    [InlineData("50%", null)]
    [InlineData("lots", null)]
    [InlineData("", null)]
    [InlineData("0", null)]
    public void AMemoryLimitIsReadInIncusUnitsAndWhatHasNoDockerFormIsLeftAlone(string size, long? expected) =>
        Assert.Equal(expected, DockerSpec.Bytes(size));

    [Fact]
    public void NestingIsNotHonouredAndSaysSo()
    {
        var spec = SessionSpec();

        Assert.Empty(DockerSpec.Notes(spec));

        spec = With(spec, (InstanceSpec.Nesting, "true"));

        var container = DockerSpec.ForInstance(spec, Network, Config);

        Assert.Empty(container.CapAdd);
        Assert.Empty(container.SecurityOpt);
        Assert.DoesNotContain(container.Mounts, m => m.Type != "volume");
        Assert.Contains("privileged", Assert.Single(DockerSpec.Notes(spec)), StringComparison.Ordinal);
    }

    // Volumes.

    [Fact]
    public void VolumesAreNamedForTheInstanceAndAreTheOnesTheContainerMounts()
    {
        var plan = Plan();
        var session = SessionSpec(plan);
        var service = With(ServiceSpec(plan), (DockerSpec.Keys.Data, "/data"));

        Assert.Equal(["proj-sess-home", "proj-sess-work"], DockerSpec.VolumesFor(session));
        Assert.Equal(["proj-sess-db-data"], DockerSpec.VolumesFor(service));
        Assert.Empty(DockerSpec.VolumesFor(ServiceSpec(plan)));

        // Stable: a container made again finds the same state.
        Assert.Equal(DockerSpec.VolumesFor(session), DockerSpec.VolumesFor(SessionSpec(Plan())));

        Assert.Equal(
            DockerSpec.VolumesFor(session),
            DockerSpec.ForInstance(session, Network, Config).Mounts.Select(m => m.Source));

        Assert.Equal(
            DockerSpec.VolumesFor(service),
            DockerSpec.ForInstance(service, Network, Config).Mounts.Select(m => m.Source));
    }

    [Fact]
    public void TheLongestNameAPlanAllowsIsStillAVolumeName()
    {
        // 63 characters: the most SessionPlan.Resolve lets an instance name be.
        var project = new string('p', 40);
        var session = new string('s', 22);
        var plan = SessionPlan.Resolve(
            new SessionConfig
            {
                Name = project,
                Services = new Dictionary<string, ServiceConfig> { ["Data Base"] = new ServiceConfig { Type = "postgres", Password = "pw" } },
            },
            Directory,
            session);

        Assert.Equal(63, plan.InstanceName.Length);

        var names = DockerSpec.VolumesFor(SessionSpec(plan))
            .Concat(DockerSpec.VolumesFor(With(ServiceSpec(plan), (DockerSpec.Keys.Data, "/data"))))
            .ToList();

        Assert.Equal(3, names.Count);
        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());

        // The engine's own rule for a volume's name, and a directory's for its length.
        Assert.All(names, n => Assert.Matches(new Regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]+$"), n));
        Assert.All(names, n => Assert.True(n.Length <= 255, n));
        Assert.All(names, n => Assert.StartsWith(plan.InstanceName, n, StringComparison.Ordinal));
    }

    [Fact]
    public void AVolumeCarriesWhatPruneSelectsOn()
    {
        var plan = Plan();
        var service = With(ServiceSpec(plan), (DockerSpec.Keys.Data, "/data"));

        Assert.Equal(
            new Dictionary<string, string>
            {
                [DockerSpec.Labels.Instance] = "proj-sess",
                [DockerSpec.Labels.Volume] = "work",
                [DockerSpec.Labels.Schema] = InstanceSpec.Keys.SchemaVersion,
                [DockerSpec.Labels.Project] = "proj",
                [DockerSpec.Labels.Session] = "sess",
                [DockerSpec.Labels.Directory] = plan.Directory,
                [DockerSpec.Labels.Branch] = plan.Branch,
                [DockerSpec.Labels.Created] = "1800000000",
            },
            DockerSpec.VolumeLabels(SessionSpec(plan), "proj-sess-work"));

        var data = DockerSpec.VolumeLabels(service, "proj-sess-db-data");

        Assert.Equal("data", data[DockerSpec.Labels.Volume]);
        Assert.Equal("db", data[DockerSpec.Labels.Service]);
        Assert.Equal("proj-sess-db", data[DockerSpec.Labels.Instance]);

        Assert.Throws<ArgumentException>(() => DockerSpec.VolumeLabels(service, "proj-sess-home"));
    }

    // The isolation guarantee.

    private static ContainerCreate Clean() => DockerSpec.ForInstance(SessionSpec(), Network, Config);

    [Fact]
    public void WhatForInstanceMakesHasNoProblems()
    {
        var plan = Plan();

        Assert.Empty(DockerSpec.Problems(Clean()));
        Assert.Empty(DockerSpec.Problems(DockerSpec.ForInstance(ServiceSpec(plan), Network, Config)));
    }

    [Fact]
    public void APublishedPortIsAProblemWhateverAddressItIsOn()
    {
        foreach (var host in new[] { "", "0.0.0.0", "127.0.0.1", "127.3.7.1" })
        {
            var container = Clean() with { Ports = [new PortBinding(5173, host, 5173)] };

            var problem = Assert.Single(DockerSpec.Problems(container));
            Assert.Contains("publishes nothing", problem, StringComparison.Ordinal);
            Assert.Contains("5173", problem, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("host")]
    [InlineData("none")]
    [InlineData("bridge")]
    [InlineData("default")]
    [InlineData("container:web-a")]
    public void AnyNetworkButAUserDefinedOneIsAProblem(string? network)
    {
        var container = Clean() with { Network = network };

        Assert.Contains("network", Assert.Single(DockerSpec.Problems(container)), StringComparison.Ordinal);
    }

    [Fact]
    public void BorrowingAnotherContainersStackIsAProblem()
    {
        var container = Clean() with { NetworkMode = "container:web-a" };

        Assert.Contains("somebody else's network stack", Assert.Single(DockerSpec.Problems(container)), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("bind", "/var/run/docker.sock", "/var/run/docker.sock")]
    [InlineData("bind", "//var/run/docker.sock", "/run/docker.sock")]
    [InlineData("npipe", @"\\.\pipe\docker_engine", @"\\.\pipe\docker_engine")]
    [InlineData("volume", "sneaky", "/var/run/docker.sock")]
    public void TheEnginesSocketIsNeverMounted(string type, string source, string target)
    {
        var container = Clean() with { Mounts = [new MountSpec(type, source, target)] };

        Assert.Contains("engine's own socket", Assert.Single(DockerSpec.Problems(container)), StringComparison.Ordinal);
    }

    [Fact]
    public void NothingOfTheHostsIsMountedAtAll()
    {
        var container = Clean() with
        {
            Mounts =
            [
                new MountSpec("volume", "proj-sess-home", "/home"),
                new MountSpec("tmpfs", "", "/tmp"),
                new MountSpec("bind", "C:\\Users\\someone", "/host", ReadOnly: true),
            ],
        };

        var problem = Assert.Single(DockerSpec.Problems(container));
        Assert.Contains("bind mount", problem, StringComparison.Ordinal);
        Assert.Contains("C:\\Users\\someone", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void NoCapabilityIsAddedAndNoConfinementSwitchedOff()
    {
        var container = Clean() with
        {
            CapAdd = ["SYS_ADMIN", "NET_ADMIN"],
            SecurityOpt = ["seccomp=unconfined", "apparmor=unconfined", "no-new-privileges", "no-new-privileges:true"],
        };

        var problems = DockerSpec.Problems(container);

        Assert.Equal(4, problems.Count);
        Assert.Contains(problems, p => p.Contains("SYS_ADMIN", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("NET_ADMIN", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("seccomp=unconfined", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("apparmor=unconfined", StringComparison.Ordinal));
    }

    [Fact]
    public void EveryProblemIsReportedNotOnlyTheFirst()
    {
        var container = Clean() with
        {
            Network = "host",
            Ports = [new PortBinding(80, "0.0.0.0", 8080), new PortBinding(22, "127.0.0.1", 22)],
            Mounts = [new MountSpec("bind", "/var/run/docker.sock", "/var/run/docker.sock")],
            CapAdd = ["ALL"],
        };

        Assert.Equal(5, DockerSpec.Problems(container).Count);
    }

    [Fact]
    public void ForInstanceRefusesANetworkThatIsNotTheSessionsOwn()
    {
        var refused = Assert.Throws<BackendException>(() => DockerSpec.ForInstance(SessionSpec(), "bridge", Config));

        Assert.Contains("proj-sess", refused.Message, StringComparison.Ordinal);
        Assert.Contains("bridge", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ContainerCreateHasNoFieldTheValidatorHasNotBeenToldAbout()
    {
        // The guarantee is only as wide as the model: there is no `Privileged`,
        // no `PidMode`, no `Devices`, so they cannot be asked for. The day the
        // engine gains one, this fails, and whoever adds it decides here —
        // in DockerSpec.Problems — what it is allowed to be.
        var known = new[]
        {
            "Image", "Entrypoint", "Cmd", "Hostname", "User", "WorkingDir", "Tty", "Init", "Env", "Labels",
            "Ports", "Mounts", "Network", "NetworkAliases", "ExtraHosts", "CapAdd", "SecurityOpt",
            "MemoryBytes", "NanoCpus", "Sysctls", "NetworkMode", "AutoRemove", "GroupAdd",
        };

        var actual = typeof(ContainerCreate)
            .GetProperties()
            .Select(p => p.Name)
            .Where(n => n != "EqualityContract");

        Assert.Equal(known.Order(StringComparer.Ordinal), actual.Order(StringComparer.Ordinal));
    }
}
