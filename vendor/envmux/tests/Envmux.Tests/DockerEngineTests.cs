using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Docker;

namespace Envmux.Tests;

/// <summary>
/// The parts of the engine client that need no engine: where it is, what is
/// written to it, what is made of what it says.
/// </summary>
public sealed class DockerEngineTests
{
    // Where the engine is.

    private static EngineEndpoint Resolve(
        string? endpoint = null,
        string? home = null,
        bool windows = true,
        params (string Name, string Value)[] environment) =>
        EngineEndpoint.Resolve(
            endpoint,
            name => environment.FirstOrDefault(e => e.Name == name).Value,
            home ?? Path.Combine(Path.GetTempPath(), "swarmtest-engine-no-such-home"),
            windows);

    [Theory]
    [InlineData("npipe:////./pipe/docker_engine", "Pipe", "docker_engine")]
    [InlineData("npipe://./pipe/dockerDesktopLinuxEngine", "Pipe", "dockerDesktopLinuxEngine")]
    [InlineData(@"npipe://\\.\pipe\docker_engine", "Pipe", "docker_engine")]
    [InlineData("unix:///var/run/docker.sock", "Unix", "/var/run/docker.sock")]
    [InlineData("unix:///home/matt/.docker/desktop/docker.sock", "Unix", "/home/matt/.docker/desktop/docker.sock")]
    [InlineData("unix://", "Unix", "/var/run/docker.sock")]
    [InlineData("tcp://127.0.0.1:2375", "Tcp", "127.0.0.1:2375")]
    [InlineData("tcp://localhost", "Tcp", "localhost:2375")]
    [InlineData("tcp://[::1]", "Tcp", "[::1]:2375")]
    [InlineData("tcp://[::1]:2376/", "Tcp", "[::1]:2376")]
    public void AnEndpointIsReadTheWayDockerHostSpellsIt(string value, string transport, string address)
    {
        var endpoint = EngineEndpoint.Parse(value, "DOCKER_HOST");

        Assert.Equal(transport, endpoint.Transport.ToString());
        Assert.Equal(address, endpoint.Address);
    }

    [Fact]
    public void AnEndpointDisplaysAsItWouldBeTyped()
    {
        Assert.Equal("npipe:////./pipe/docker_engine", new EngineEndpoint(EngineTransport.Pipe, "docker_engine").Display);
        Assert.Equal("unix:///var/run/docker.sock", new EngineEndpoint(EngineTransport.Unix, "/var/run/docker.sock").Display);
        Assert.Equal("tcp://127.0.0.1:2375", new EngineEndpoint(EngineTransport.Tcp, "127.0.0.1:2375").Display);
    }

    [Theory]
    [InlineData("ssh://matt@build-box", "not over ssh")]
    [InlineData("docker_engine", "npipe://, unix:// or tcp://")]
    [InlineData("npipe:////./docker_engine", "does not name a pipe")]
    [InlineData("tcp://", "names no host")]
    public void AnEndpointEnvmuxCannotSpeakToIsRefusedInASentence(string value, string expected)
    {
        var refused = Assert.Throws<DockerEngineException>(() => EngineEndpoint.Parse(value, "DOCKER_HOST"));

        Assert.Contains(expected, refused.Message, StringComparison.Ordinal);
        Assert.Contains(value, refused.Message, StringComparison.Ordinal);
        Assert.StartsWith("DOCKER_HOST is", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("tcp://build-box:2375")]
    [InlineData("http://192.0.2.10:2375")]
    [InlineData("http://user:private-value@127.0.0.1:2375")]
    public void RemoteOrCredentialBearingTcpIsRefusedWithoutEchoingIt(string value)
    {
        var refused = Assert.Throws<DockerEngineException>(() => EngineEndpoint.Parse(value, "DOCKER_HOST"));
        Assert.Contains("loopback", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(value, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WithNothingSaidTheDefaultIsThePlatforms()
    {
        Assert.Equal(new EngineEndpoint(EngineTransport.Pipe, "docker_engine"), Resolve(windows: true));
        Assert.Equal(new EngineEndpoint(EngineTransport.Unix, "/var/run/docker.sock"), Resolve(windows: false));
    }

    [Fact]
    public void WhatWasAskedForBeatsTheEnvironmentWhichBeatsTheContext()
    {
        using var home = new DockerHome("desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine");

        Assert.Equal("dockerDesktopLinuxEngine", Resolve(home: home.Path).Address);
        Assert.Equal("from-env", Resolve(home: home.Path, environment: ("DOCKER_HOST", "npipe:////./pipe/from-env")).Address);

        Assert.Equal(
            "asked-for",
            Resolve("npipe:////./pipe/asked-for", home.Path, environment: ("DOCKER_HOST", "npipe:////./pipe/from-env")).Address);
    }

    [Fact]
    public void TheCurrentContextIsReadFromWhereTheCliKeepsIt()
    {
        using var home = new DockerHome("desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine");
        home.AddContext("colima", "unix:///Users/matt/.colima/default/docker.sock");

        Assert.Equal(new EngineEndpoint(EngineTransport.Pipe, "dockerDesktopLinuxEngine"), Resolve(home: home.Path));

        // DOCKER_CONTEXT names another one, as it does for the CLI.
        Assert.Equal(
            new EngineEndpoint(EngineTransport.Unix, "/Users/matt/.colima/default/docker.sock"),
            Resolve(home: home.Path, windows: false, environment: ("DOCKER_CONTEXT", "colima")));

        // "default" is not a directory on disk; it means what it says.
        Assert.Equal("docker_engine", Resolve(home: home.Path, environment: ("DOCKER_CONTEXT", "default")).Address);
    }

    [Fact]
    public void AConfigThatCannotBeReadIsNotAReasonToRefuseTheDefault()
    {
        using var home = new DockerHome("desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine");

        File.WriteAllText(System.IO.Path.Combine(home.Path, ".docker", "config.json"), "{ this is not json");
        Assert.Equal("docker_engine", Resolve(home: home.Path).Address);

        // A context that is named and has no meta on disk falls through the same way.
        File.WriteAllText(System.IO.Path.Combine(home.Path, ".docker", "config.json"), """{"currentContext":"gone"}""");
        Assert.Equal("docker_engine", Resolve(home: home.Path).Address);
    }

    [Fact]
    public void TlsToAnEngineIsRefusedRatherThanSpokenToInPlainHttp()
    {
        var refused = Assert.Throws<DockerEngineException>(() => Resolve(
            environment: [("DOCKER_HOST", "tcp://build-box:2376"), ("DOCKER_TLS_VERIFY", "1")]));

        Assert.Contains("DOCKER_TLS_VERIFY", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NothingListeningIsOneSentenceThatNamesTheEndpoint()
    {
        var pipe = new EngineEndpoint(EngineTransport.Pipe, "docker_engine").NotAnswering();
        Assert.Equal("Docker is not answering on npipe:////./pipe/docker_engine — is Docker Desktop running?", pipe.Message);
        Assert.IsAssignableFrom<BackendException>(pipe);

        var denied = new EngineEndpoint(EngineTransport.Unix, "/var/run/docker.sock").NotAnswering(new UnauthorizedAccessException());
        Assert.Contains("access to the engine is denied", denied.Message, StringComparison.Ordinal);
    }

    // Which API.

    [Theory]
    [InlineData("1.55", "1.40", "1.44")] // Docker Desktop 29.6.1, as found: the tested version is on offer, so it is used
    [InlineData("1.44", "1.24", "1.44")]
    [InlineData("1.43", "1.12", "1.43")] // older than preferred: its newest
    [InlineData("1.41", null, "1.41")]
    [InlineData("1.60", "1.50", "1.50")] // the preferred one retired: the nearest it still has
    public void TheApiSpokenIsTheTestedOneWhereItIsOnOffer(string newest, string? oldest, string expected) =>
        Assert.Equal(expected, DockerEngineClient.Negotiate(newest, oldest, "29.6.1"));

    [Fact]
    public void AnEngineTooOldIsRefusedWithWhatToDo()
    {
        var refused = Assert.Throws<DockerEngineException>(() => DockerEngineClient.Negotiate("1.40", "1.12", "19.03.15"));

        Assert.Equal(
            "Docker 19.03.15 speaks API 1.40, and envmux needs 1.41 or newer — that is Docker 20.10. Update Docker and try again.",
            refused.Message);

        // 1.9 is older than 1.41, which a string comparison does not know.
        Assert.Throws<DockerEngineException>(() => DockerEngineClient.Negotiate("1.9", null, "1.0"));
        Assert.Throws<DockerEngineException>(() => DockerEngineClient.Negotiate("", null, "?"));
    }

    // What is written.

    [Fact]
    public void AContainerIsWrittenAsTheEnginesNestedConfig()
    {
        var body = EngineJson.CreateBody(new ContainerCreate
        {
            Image = "envmux/golden:abc123",
            Cmd = ["sleep", "infinity"],
            Hostname = "feature-x",
            User = "dev",
            WorkingDir = "/work",
            Env = new Dictionary<string, string> { ["ENVMUX_ADDRESS"] = "127.3.7.1" },
            Labels = new Dictionary<string, string> { ["envmux.session"] = "feature-x" },
            Ports =
            [
                new PortBinding(5173, "127.3.7.1", 5173),
                new PortBinding(22, "127.3.7.1", 22),
                new PortBinding(5173, "127.3.7.2", 5173),
            ],
            Mounts = [new MountSpec("volume", "envmux-feature-x-home", "/home"), new MountSpec("tmpfs", "", "/scratch", ReadOnly: true)],
            Network = "envmux-lo-7",
            NetworkAliases = ["app", "feature-x"],
            ExtraHosts = ["host.docker.internal:host-gateway"],
            CapAdd = ["SYS_PTRACE"],
            SecurityOpt = ["no-new-privileges"],
            Sysctls = new Dictionary<string, string>
            {
                ["net.ipv4.conf.all.route_localnet"] = "1",
                ["net.ipv6.conf.all.disable_ipv6"] = "1",
            },
            GroupAdd = ["999"],
            MemoryBytes = 4L * 1024 * 1024 * 1024,
            NanoCpus = 2_000_000_000,
        });

        AssertJson(
            """
            {
              "Image": "envmux/golden:abc123",
              "Cmd": ["sleep", "infinity"],
              "Hostname": "feature-x",
              "User": "dev",
              "WorkingDir": "/work",
              "Env": ["ENVMUX_ADDRESS=127.3.7.1"],
              "Labels": { "envmux.session": "feature-x" },
              "ExposedPorts": { "5173/tcp": {}, "22/tcp": {} },
              "NetworkingConfig": {
                "EndpointsConfig": { "envmux-lo-7": { "Aliases": ["app", "feature-x"] } }
              },
              "HostConfig": {
                "Init": true,
                "PortBindings": {
                  "5173/tcp": [
                    { "HostIp": "127.3.7.1", "HostPort": "5173" },
                    { "HostIp": "127.3.7.2", "HostPort": "5173" }
                  ],
                  "22/tcp": [{ "HostIp": "127.3.7.1", "HostPort": "22" }]
                },
                "Mounts": [
                  { "Type": "volume", "Source": "envmux-feature-x-home", "Target": "/home", "ReadOnly": false },
                  { "Type": "tmpfs", "Target": "/scratch", "ReadOnly": true }
                ],
                "NetworkMode": "envmux-lo-7",
                "ExtraHosts": ["host.docker.internal:host-gateway"],
                "CapAdd": ["SYS_PTRACE"],
                "SecurityOpt": ["no-new-privileges"],
                "Sysctls": { "net.ipv4.conf.all.route_localnet": "1", "net.ipv6.conf.all.disable_ipv6": "1" },
                "GroupAdd": ["999"],
                "Memory": 4294967296,
                "NanoCpus": 2000000000
              }
            }
            """,
            body.ToJsonString());
    }

    [Fact]
    public void AContainerWithNothingSaidIsAnImageAndAnInit()
    {
        AssertJson(
            """{ "Image": "busybox:stable", "HostConfig": { "Init": true } }""",
            EngineJson.CreateBody(new ContainerCreate { Image = "busybox:stable" }).ToJsonString());

        // A terminal with its input closed is a shell that exits at once.
        AssertJson(
            """{ "Image": "busybox:stable", "Tty": true, "OpenStdin": true, "HostConfig": { "Init": false } }""",
            EngineJson.CreateBody(new ContainerCreate { Image = "busybox:stable", Tty = true, Init = false }).ToJsonString());

        // A network and no aliases is still an endpoint on that network.
        AssertJson(
            """
            {
              "Image": "busybox:stable",
              "NetworkingConfig": { "EndpointsConfig": { "envmux-lo-7": {} } },
              "HostConfig": { "Init": true, "NetworkMode": "envmux-lo-7" }
            }
            """,
            EngineJson.CreateBody(new ContainerCreate { Image = "busybox:stable", Network = "envmux-lo-7" }).ToJsonString());
    }

    [Fact]
    public void AHelperInAnotherContainersNetworkClaimsNoneOfItsOwn()
    {
        // container:<name> is the session's own stack, borrowed. The engine refuses a
        // hostname, a port or an endpoint on top of it, so whatever the spec says about
        // those is not written — and Network loses to NetworkMode.
        var body = EngineJson.CreateBody(new ContainerCreate
        {
            Image = "envmux/golden:abc123",
            Cmd = ["nft", "-f", "-"],
            Hostname = "helper",
            Network = "envmux-lo-7",
            NetworkAliases = ["helper"],
            NetworkMode = "container:envmux-shop-feature-x",
            Ports = [new PortBinding(5173, "127.3.7.1", 5173)],
            CapAdd = ["NET_ADMIN"],
            AutoRemove = true,
            Init = false,
        });

        AssertJson(
            """
            {
              "Image": "envmux/golden:abc123",
              "Cmd": ["nft", "-f", "-"],
              "HostConfig": {
                "Init": false,
                "NetworkMode": "container:envmux-shop-feature-x",
                "CapAdd": ["NET_ADMIN"],
                "AutoRemove": true
              }
            }
            """,
            body.ToJsonString());
    }

    [Fact]
    public void AnExecIsWrittenWithItsSizeHeightFirst()
    {
        var spec = new ExecCreate
        {
            Cmd = ["tmux", "attach"],
            Tty = true,
            AttachStdin = true,
            User = "dev",
            WorkingDir = "/work",
            Env = new Dictionary<string, string> { ["TERM"] = "xterm-256color" },
            ConsoleSize = (132, 43),
        };

        AssertJson(
            """
            {
              "Cmd": ["tmux", "attach"], "Tty": true, "AttachStdin": true, "AttachStdout": true, "AttachStderr": true,
              "User": "dev", "WorkingDir": "/work", "Env": ["TERM=xterm-256color"], "ConsoleSize": [43, 132]
            }
            """,
            EngineJson.ExecBody(spec).ToJsonString());

        // An engine before 1.42 refuses the field, and one without a terminal has no use for it.
        Assert.DoesNotContain("ConsoleSize", EngineJson.ExecBody(spec, consoleSize: false).ToJsonString(), StringComparison.Ordinal);
        Assert.DoesNotContain("ConsoleSize", EngineJson.ExecBody(spec with { Tty = false }).ToJsonString(), StringComparison.Ordinal);
    }

    [Fact]
    public void LabelsBecomeTheFilterTheEngineReads()
    {
        Assert.Null(EngineJson.LabelFilter(null));
        Assert.Null(EngineJson.LabelFilter(new Dictionary<string, string>()));

        AssertJson(
            """{ "label": ["envmux.project=shop", "envmux.session=feature-x", "envmux.managed"] }""",
            EngineJson.LabelFilter(new Dictionary<string, string>
            {
                ["envmux.project"] = "shop",
                ["envmux.session"] = "feature-x",
                ["envmux.managed"] = "",
            })!);
    }

    [Theory]
    [InlineData("busybox", "busybox", "latest")]
    [InlineData("busybox:stable", "busybox", "stable")]
    [InlineData("localhost:5000/envmux/golden", "localhost:5000/envmux/golden", "latest")]
    [InlineData("localhost:5000/envmux/golden:abc", "localhost:5000/envmux/golden", "abc")]
    [InlineData("ghcr.io/x/y@sha256:0123", "ghcr.io/x/y", "sha256:0123")]
    public void AReferenceWithNoTagMeansLatestAndSaysSo(string reference, string repository, string tag) =>
        Assert.Equal((repository, tag), EngineJson.SplitReference(reference));

    // What is read.

    [Fact]
    public void ARunningContainerIsFlattenedFromWhatTheEngineReallySays()
    {
        using var document = JsonDocument.Parse(CapturedInspect);
        var inspect = EngineJson.Inspect(document.RootElement);

        Assert.Equal("8178666b2d582bbedb9654642c40bee5890339d3f79d64dadad2b58f59e3e12f", inspect.Id);
        Assert.Equal("swarmtest-engine-cap", inspect.Name);
        Assert.Equal("busybox:stable", inspect.Image);
        Assert.Equal("running", inspect.Status);
        Assert.True(inspect.Running);
        Assert.Null(inspect.ExitCode);
        Assert.Equal("feature-x", inspect.Labels["envmux.session"]);

        // Sorted, because the engine's own order is not the same twice. 9000 is
        // exposed without being published, and is not a binding.
        Assert.Equal(
            [
                new PortBinding(22, "127.9.1.1", 10022),
                new PortBinding(5173, "127.9.1.1", 15173),
                new PortBinding(5173, "127.9.1.3", 15173),
            ],
            inspect.Ports);

        // A volume by its name, and the tmpfs once although the engine lists it in two places.
        Assert.Equal(
            [new MountSpec("volume", "swarmtest-engine-cap-home", "/home"), new MountSpec("tmpfs", "", "/scratch")],
            inspect.Mounts);

        Assert.Equal("172.30.0.2", Assert.Single(inspect.NetworkAddresses).Value);
        Assert.Equal("swarmtest-engine-cap-net", Assert.Single(inspect.NetworkAddresses).Key);
    }

    [Fact]
    public void AStoppedContainerStillSaysWhatItWouldPublish()
    {
        // What the same container said after `docker stop`: the differences, applied to the capture.
        var stopped = CapturedInspect
            .Replace("\"Status\": \"running\"", "\"Status\": \"exited\"", StringComparison.Ordinal)
            .Replace("\"Running\": true", "\"Running\": false", StringComparison.Ordinal)
            .Replace("\"ExitCode\": 0", "\"ExitCode\": 143", StringComparison.Ordinal)
            .Replace("\"IPAddress\": \"172.30.0.2\"", "\"IPAddress\": \"\"", StringComparison.Ordinal);

        var ports = stopped.IndexOf("\"Ports\": {", StringComparison.Ordinal);
        var networks = stopped.IndexOf("\"Networks\": {", StringComparison.Ordinal);
        stopped = string.Concat(stopped.AsSpan(0, ports), "\"Ports\": {}, ", stopped.AsSpan(networks));

        using var document = JsonDocument.Parse(stopped);
        var inspect = EngineJson.Inspect(document.RootElement);

        Assert.False(inspect.Running);
        Assert.Equal(143, inspect.ExitCode);
        Assert.Equal(3, inspect.Ports.Count);
        Assert.Contains(new PortBinding(5173, "127.9.1.3", 15173), inspect.Ports);
        Assert.Equal("", inspect.NetworkAddresses["swarmtest-engine-cap-net"]);
    }

    [Fact]
    public void AContainerThatHasNeverRunHasNoExitCode()
    {
        using var document = JsonDocument.Parse(
            """{ "Id": "abc", "Name": "/x", "State": { "Status": "created", "Running": false, "ExitCode": 0 } }""");

        var inspect = EngineJson.Inspect(document.RootElement);

        Assert.Null(inspect.ExitCode);
        Assert.Empty(inspect.Ports);
        Assert.Empty(inspect.Mounts);
        Assert.Empty(inspect.Labels);
    }

    [Fact]
    public void APortExposedAndNotPublishedIsNotABinding()
    {
        // How older engines list one: the key, with null under it.
        using var document = JsonDocument.Parse(
            """{ "State": { "Status": "running", "Running": true }, "NetworkSettings": { "Ports": { "9000/tcp": null, "53/udp": [{ "HostIp": "127.9.1.1", "HostPort": "5353" }] } } }""");

        Assert.Equal([new PortBinding(53, "127.9.1.1", 5353, "udp")], EngineJson.Inspect(document.RootElement).Ports);
    }

    [Fact]
    public void ListingsAreReadWithTheirLabelsAndWithoutTheLeadingSlash()
    {
        using var containers = JsonDocument.Parse(
            """[{ "Id": "abc", "Names": ["/feature-x"], "Image": "envmux/golden:1", "State": "running", "Labels": { "a": "b" } }]""");

        var summary = EngineJson.Summary(containers.RootElement[0]);
        Assert.Equal(["feature-x"], summary.Names);
        Assert.Equal("running", summary.State);
        Assert.Equal("b", summary.Labels["a"]);

        // No labels is null on the wire, not an empty object.
        using var network = JsonDocument.Parse("""{ "Id": "n1", "Name": "envmux-lo-7", "Labels": null }""");
        Assert.Empty(EngineJson.Network(network.RootElement).Labels);

        using var image = JsonDocument.Parse(
            """{ "Id": "sha256:1", "RepoTags": ["envmux/golden:1"], "Config": { "Labels": { "envmux.build": "1" } } }""");

        Assert.Equal("1", EngineJson.Image(image.RootElement).Labels["envmux.build"]);

        using var exec = JsonDocument.Parse("""{ "Running": false, "ExitCode": 3, "Pid": 77 }""");
        Assert.Equal(new ExecInspect(false, 3, 77), EngineJson.Exec(exec.RootElement));

        using var running = JsonDocument.Parse("""{ "Running": true, "ExitCode": null, "Pid": 77 }""");
        Assert.Null(EngineJson.Exec(running.RootElement).ExitCode);
    }

    // What goes wrong.

    [Fact]
    public void ARefusalIsTheEnginesOwnSentenceAndItsStatus()
    {
        var conflict = DockerEngineClient.Failure(
            HttpMethod.Post,
            "/v1.44/networks/create",
            409,
            """{"message":"network with name envmux-lo-7 already exists"}""");

        Assert.Equal("network with name envmux-lo-7 already exists", conflict.Message);
        Assert.Equal(409, conflict.Status);
        Assert.True(conflict.IsConflict);
        Assert.False(conflict.IsNotFound);

        var missing = DockerEngineClient.Failure(HttpMethod.Get, "/v1.44/containers/x/json", 404, """{"message":"No such container: x"}""");
        Assert.True(missing.IsNotFound);

        // Something in between that is not an engine: a status, and what it said, in one line.
        var proxy = DockerEngineClient.Failure(HttpMethod.Get, "/version", 502, "<html>\r\n<h1>Bad Gateway</h1></html>");
        Assert.Equal("<html> <h1>Bad Gateway</h1></html>", proxy.Message);

        var silent = DockerEngineClient.Failure(HttpMethod.Post, "/v1.44/containers/x/start", 500, "");
        Assert.Equal("POST /v1.44/containers/x/start answered 500", silent.Message);
    }

    [Fact]
    public async Task AFailureInsideAProgressStreamIsThrownAndTheRestIsReadable()
    {
        var pull = Lines(
            """{"status":"Pulling from library/busybox","id":"stable"}""",
            """{"status":"Pulling fs layer","progressDetail":{},"id":"9c0ab1c3f4e8"}""",
            """{"status":"Downloading","progressDetail":{"current":1,"total":9},"progress":"[>  ]","id":"9c0ab1c3f4e8"}""",
            """{"status":"Downloading","progressDetail":{"current":5,"total":9},"progress":"[=> ]","id":"9c0ab1c3f4e8"}""",
            """{"status":"Pull complete","progressDetail":{},"id":"9c0ab1c3f4e8"}""",
            """{"status":"Status: Downloaded newer image for busybox:stable"}""");

        var seen = new List<string>();

        await foreach (var line in DockerEngineClient.ProgressLinesAsync(pull, "pulling busybox:stable"))
        {
            seen.Add(line);
        }

        // A layer's hundred progress ticks are one line: its change of status.
        Assert.Equal(
            [
                "stable: Pulling from library/busybox",
                "9c0ab1c3f4e8: Pulling fs layer",
                "9c0ab1c3f4e8: Downloading",
                "9c0ab1c3f4e8: Pull complete",
                "Status: Downloaded newer image for busybox:stable",
            ],
            seen);

        var build = Lines(
            """{"stream":"Step 1/2 : FROM busybox:stable\n"}""",
            """{"stream":" ---> 73aaf090f3d8\nStep 2/2 : RUN exit 7\n"}""",
            """{"errorDetail":{"code":7,"message":"The command '/bin/sh -c exit 7' returned a non-zero code: 7"},"error":"The command '/bin/sh -c exit 7' returned a non-zero code: 7"}""");

        seen.Clear();

        var failed = await Assert.ThrowsAsync<DockerEngineException>(async () =>
        {
            await foreach (var line in DockerEngineClient.ProgressLinesAsync(build, "building envmux/golden:1"))
            {
                seen.Add(line);
            }
        });

        Assert.Equal(["Step 1/2 : FROM busybox:stable", " ---> 73aaf090f3d8", "Step 2/2 : RUN exit 7"], seen);
        Assert.Equal("building envmux/golden:1 failed: The command '/bin/sh -c exit 7' returned a non-zero code: 7", failed.Message);
    }

    // The framing of an exec with no terminal.

    [Fact]
    public async Task FramedOutputComesApartIntoItsTwoStreams()
    {
        using var framed = new MemoryStream();
        framed.Write(StdCopy.Frame(StdCopy.Stdout, "out-1 "u8));
        framed.Write(StdCopy.Frame(StdCopy.Stderr, "err-1 "u8));
        framed.Write(StdCopy.Frame(StdCopy.Stdout, []));
        framed.Write(StdCopy.Frame(StdCopy.Stdout, new byte[100_000]));
        framed.Write(StdCopy.Frame(StdCopy.Stderr, "err-2"u8));
        framed.Position = 0;

        using var stdout = new MemoryStream();
        using var stderr = new MemoryStream();

        // One byte at a time, which is the worst a connection is allowed to do.
        await StdCopyReader.CopyAsync(new Trickle(framed), stdout, stderr);

        Assert.Equal(6 + 100_000, stdout.Length);
        Assert.Equal("err-1 err-2", Encoding.UTF8.GetString(stderr.ToArray()));
    }

    [Fact]
    public async Task AStreamThatEndsInsideAFrameSimplyEnds()
    {
        var whole = StdCopy.Frame(StdCopy.Stdout, "complete"u8);
        var cut = StdCopy.Frame(StdCopy.Stdout, "never finished"u8)[..12];

        using var stdout = new MemoryStream();
        await StdCopyReader.CopyAsync(new MemoryStream([.. whole, .. cut]), stdout, null);

        Assert.Equal("complete", Encoding.UTF8.GetString(stdout.ToArray()));
    }

    [Fact]
    public async Task ATerminalsOutputReadAsFramesIsNamedForWhatItIs()
    {
        var prompt = new MemoryStream("/work $ echo hi\r\nhi\r\n"u8.ToArray());

        var refused = await Assert.ThrowsAsync<DockerEngineException>(() => StdCopyReader.CopyAsync(prompt, Stream.Null, null));
        Assert.Contains("terminal", refused.Message, StringComparison.Ordinal);
    }

    private static MemoryStream Lines(params string[] lines) =>
        new(Encoding.UTF8.GetBytes(string.Join("\r\n", lines) + "\r\n"));

    /// <summary>Equal as JSON — the same members, in the same order, with the same values — whatever the whitespace.</summary>
    private static void AssertJson(string expected, string actual)
    {
        using var want = JsonDocument.Parse(expected);
        using var have = JsonDocument.Parse(actual);

        Assert.Equal(Canonical(want.RootElement), Canonical(have.RootElement));
    }

    private static string Canonical(JsonElement element) =>
        element.ValueKind switch
        {
            // The engine reads an object as a map, so the order of its members is not part of the shape.
            JsonValueKind.Object => "{" + string.Join(",", element.EnumerateObject()
                .OrderBy(p => p.Name, StringComparer.Ordinal)
                .Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
            JsonValueKind.Array => "[" + string.Join(",", element.EnumerateArray().Select(Canonical)) + "]",
            _ => element.GetRawText(),
        };

    /// <summary>A <c>~/.docker</c> with a current context in it.</summary>
    private sealed class DockerHome : IDisposable
    {
        public DockerHome(string currentContext, string host)
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "swarmtest-engine-home-" + Guid.NewGuid().ToString("N")[..8]);
            Directory.CreateDirectory(System.IO.Path.Combine(Path, ".docker"));

            File.WriteAllText(
                System.IO.Path.Combine(Path, ".docker", "config.json"),
                $$"""{ "auths": {}, "credsStore": "desktop", "currentContext": "{{currentContext}}" }""");

            AddContext(currentContext, host);
        }

        public string Path { get; }

        public void AddContext(string name, string host)
        {
            var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(name)));
            var directory = System.IO.Path.Combine(Path, ".docker", "contexts", "meta", digest);
            Directory.CreateDirectory(directory);

            // The shape Docker Desktop writes, as found on this machine.
            File.WriteAllText(
                System.IO.Path.Combine(directory, "meta.json"),
                """{"Name":"NAME","Metadata":{"Description":"Docker Desktop"},"Endpoints":{"docker":{"Host":"HOST","SkipTLSVerify":false}}}"""
                    .Replace("NAME", name, StringComparison.Ordinal)
                    .Replace("HOST", host, StringComparison.Ordinal));
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    /// <summary>A stream that gives one byte per read.</summary>
    private sealed class Trickle(Stream inner) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, Math.Min(1, count));

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            inner.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>
    /// <c>GET /v1.44/containers/swarmtest-engine-cap/json</c> from Docker Desktop
    /// 29.6.1 on 2026-09-19, with the long lists of nothing (cgroup limits,
    /// masked paths) cut and every field this reads left as it was sent.
    /// </summary>
    private const string CapturedInspect =
        """
        {
            "Id": "8178666b2d582bbedb9654642c40bee5890339d3f79d64dadad2b58f59e3e12f",
            "Created": "2026-09-18T22:47:05.015161097Z",
            "Path": "sleep",
            "Args": ["600"],
            "State": {
                "Status": "running",
                "Running": true,
                "Paused": false,
                "Restarting": false,
                "OOMKilled": false,
                "Dead": false,
                "Pid": 54748,
                "ExitCode": 0,
                "Error": "",
                "StartedAt": "2026-09-18T22:47:05.686212174Z",
                "FinishedAt": "0001-01-01T00:00:00Z"
            },
            "Image": "sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",
            "Name": "/swarmtest-engine-cap",
            "RestartCount": 0,
            "Driver": "overlayfs",
            "Platform": "linux",
            "ExecIDs": null,
            "HostConfig": {
                "Binds": null,
                "NetworkMode": "swarmtest-engine-cap-net",
                "PortBindings": {
                    "22/tcp": [{ "HostIp": "127.9.1.1", "HostPort": "10022" }],
                    "5173/tcp": [
                        { "HostIp": "127.9.1.1", "HostPort": "15173" },
                        { "HostIp": "127.9.1.3", "HostPort": "15173" }
                    ]
                },
                "RestartPolicy": { "Name": "no", "MaximumRetryCount": 0 },
                "AutoRemove": false,
                "ExtraHosts": null,
                "Privileged": false,
                "Mounts": [
                    { "Type": "volume", "Source": "swarmtest-engine-cap-home", "Target": "/home" },
                    { "Type": "tmpfs", "Target": "/scratch" }
                ],
                "Init": true
            },
            "GraphDriver": { "Data": null, "Name": "overlayfs" },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "swarmtest-engine-cap-home",
                    "Source": "/var/lib/docker/volumes/swarmtest-engine-cap-home/_data",
                    "Destination": "/home",
                    "Driver": "local",
                    "Mode": "z",
                    "RW": true,
                    "Propagation": ""
                },
                {
                    "Type": "tmpfs",
                    "Source": "",
                    "Destination": "/scratch",
                    "Mode": "",
                    "RW": true,
                    "Propagation": ""
                }
            ],
            "Config": {
                "Hostname": "8178666b2d58",
                "Domainname": "",
                "User": "",
                "AttachStdin": false,
                "AttachStdout": true,
                "AttachStderr": true,
                "ExposedPorts": { "22/tcp": {}, "5173/tcp": {}, "9000/tcp": {} },
                "Tty": false,
                "OpenStdin": false,
                "StdinOnce": false,
                "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
                "Cmd": ["sleep", "600"],
                "Image": "busybox:stable",
                "Volumes": null,
                "WorkingDir": "",
                "Entrypoint": null,
                "Labels": { "envmux.session": "feature-x", "envmux.swarmtest": "1" },
                "StopTimeout": 1
            },
            "NetworkSettings": {
                "SandboxID": "612aaaf4f68a6277adbdd20e54ca8a3239b109613b614bd1a73e5134f2026410",
                "SandboxKey": "/var/run/docker/netns/612aaaf4f68a",
                "Ports": {
                    "22/tcp": [{ "HostIp": "127.9.1.1", "HostPort": "10022" }],
                    "5173/tcp": [
                        { "HostIp": "127.9.1.3", "HostPort": "15173" },
                        { "HostIp": "127.9.1.1", "HostPort": "15173" }
                    ]
                },
                "Networks": {
                    "swarmtest-engine-cap-net": {
                        "IPAMConfig": null,
                        "Links": null,
                        "Aliases": ["app", "8178666b2d58"],
                        "DriverOpts": null,
                        "GwPriority": 0,
                        "NetworkID": "8b2cbd780e1c302da733f04dbaca662a3d5533e8ca3b23db81cdd1141f8bb8ed",
                        "EndpointID": "0f4dbbc716bdb318c138388ac206e77cf040ce2d043364be427c8a0e312b1168",
                        "Gateway": "172.30.0.1",
                        "IPAddress": "172.30.0.2",
                        "MacAddress": "36:4a:e3:e6:21:81",
                        "IPPrefixLen": 16,
                        "IPv6Gateway": "",
                        "GlobalIPv6Address": "",
                        "GlobalIPv6PrefixLen": 0,
                        "DNSNames": ["swarmtest-engine-cap", "app", "8178666b2d58"]
                    }
                }
            }
        }
        """;
}
