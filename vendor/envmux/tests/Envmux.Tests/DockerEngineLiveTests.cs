using System.Diagnostics;
using System.Formats.Tar;
using System.Globalization;
using System.Text;

using Envmux.Backends.DockerEngine;

using Xunit.Abstractions;

namespace Envmux.Tests;

/// <summary>
/// One engine, one image, and one run at a time — for every test in <see cref="DockerEngineLiveTests"/>.
/// </summary>
/// <remarks>
/// <para>
/// Skipped, with the engine's own sentence as the reason, when nothing answers;
/// <c>ENVMUX_DOCKER_LIVE=0</c> skips it on a machine that has an engine and
/// would rather not.
/// </para>
/// <para>
/// The run holds a lock file for as long as it lasts: two <c>dotnet test</c>s
/// on one machine — which is what several worktrees of one repository are —
/// would otherwise race each other for the same fixed names and subnets.
/// </para>
/// <para>
/// The image is pulled if the engine does not have it, and removed afterwards
/// only in that case: one that was already there is somebody's.
/// </para>
/// </remarks>
public sealed class DockerEngineFixture : IAsyncLifetime
{
    public const string Image = "busybox:stable";

    private FileStream? _lock;
    private bool _pulled;

    internal DockerEngineClient? Engine { get; private set; }

    public string? SkipReason { get; private set; }

    /// <summary>Distinguishes this run's objects from a run that was killed before its <c>finally</c>.</summary>
    public string Run { get; } = Guid.NewGuid().ToString("N")[..6];

    public async Task InitializeAsync()
    {
        if (Environment.GetEnvironmentVariable("ENVMUX_DOCKER_LIVE") is "0" or "false")
        {
            SkipReason = "ENVMUX_DOCKER_LIVE=0";
            return;
        }

        DockerEngineClient engine;

        try
        {
            engine = DockerEngineClient.Connect();
            var version = await engine.VersionAsync();

            if (!version.Os.Equals("linux", StringComparison.Ordinal))
            {
                SkipReason = $"the engine on {engine.Endpoint} runs {version.Os} containers, and these tests want linux";
                await engine.DisposeAsync();
                return;
            }
        }
        catch (DockerEngineException e)
        {
            SkipReason = e.Message;
            return;
        }

        _lock = await AcquireAsync();

        if (_lock is null)
        {
            SkipReason = "another run of these tests held the lock for five minutes";
            await engine.DisposeAsync();
            return;
        }

        try
        {
            if (await engine.ImageAsync(Image) is null)
            {
                await engine.PullAsync(Image);
                _pulled = true;
            }
        }
        catch (DockerEngineException e)
        {
            SkipReason = $"could not pull {Image}: {e.Message}";
            await engine.DisposeAsync();
            return;
        }

        Engine = engine;
    }

    public async Task DisposeAsync()
    {
        try
        {
            if (Engine is not null)
            {
                if (_pulled)
                {
                    try
                    {
                        await Engine.RemoveImageAsync(Image);
                    }
                    catch (DockerEngineException)
                    {
                        // Somebody else has started using it since. Then it is theirs too.
                    }
                }

                await Engine.DisposeAsync();
            }
        }
        finally
        {
            _lock?.Dispose();
        }
    }

    private static async Task<FileStream?> AcquireAsync()
    {
        var path = Path.Combine(Path.GetTempPath(), "envmux-swarmtest-engine.lock");
        var deadline = Stopwatch.StartNew();

        while (deadline.Elapsed < TimeSpan.FromMinutes(5))
        {
            try
            {
                return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException)
            {
                await Task.Delay(500);
            }
        }

        return null;
    }
}

/// <summary>
/// <see cref="DockerEngineClient"/> against the engine on this machine.
/// </summary>
/// <remarks>
/// Everything made here is named <c>swarmtest-engine-…</c>, labelled
/// <c>envmux.swarmtest=1</c>, and removed in a <c>finally</c>. Nothing else on
/// the engine is read beyond a listing filtered to that label, and nothing else
/// is touched. Where a port is published it is on <c>127.9.1.0/24</c>, an
/// address block nothing on this machine uses, to prove the client's port
/// handling — a session never publishes one.
/// </remarks>
public sealed class DockerEngineLiveTests(DockerEngineFixture fixture, ITestOutputHelper output)
    : IClassFixture<DockerEngineFixture>
{
    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        ["envmux.swarmtest"] = "1",
    };

    private DockerEngineClient Engine
    {
        get
        {
            Skip.If(fixture.Engine is null, fixture.SkipReason);
            return fixture.Engine!;
        }
    }

    private string Name(string what) => $"swarmtest-engine-{fixture.Run}-{what}";

    [SkippableFact]
    public async Task TheVersionIsReadAndAnApiIsAgreed()
    {
        var version = await Engine.VersionAsync();

        output.WriteLine($"{Engine.Endpoint}: Docker {version.Version}, API {version.ApiVersion}, {version.Os}/{version.Arch}, {version.Platform}");

        Assert.NotEmpty(version.Version);
        Assert.Contains('.', version.ApiVersion);
        Assert.Equal("linux", version.Os);
    }

    [SkippableFact]
    public async Task ContainersOnANetworkReachEachOtherByAliasAndAreReadBackAsCreated()
    {
        var engine = Engine;
        var network = Name("net");
        var a = Name("a");
        var b = Name("b");

        try
        {
            Assert.True(await engine.CreateNetworkAsync(network, Labels));

            foreach (var (name, alias) in new[] { (a, "alpha"), (b, "beta") })
            {
                await engine.CreateContainerAsync(name, new ContainerCreate
                {
                    Image = DockerEngineFixture.Image,
                    Cmd = ["sh", "-c", $"mkdir -p /www && echo i-am-{alias} > /www/index.html && exec httpd -f -p 18080 -h /www"],
                    Labels = Labels,
                    Network = network,
                    NetworkAliases = [alias],
                });
            }

            var clock = Stopwatch.StartNew();
            await engine.StartAsync(a);
            output.WriteLine($"start returned after {clock.Elapsed.TotalMilliseconds:F0} ms");

            await engine.StartAsync(b);
            await engine.StartAsync(b); // already started is not an error

            // What inspect gives back is what create was given.
            var inspected = await engine.InspectAsync(a);
            Assert.NotNull(inspected);
            Assert.Equal(a, inspected.Name);
            Assert.True(inspected.Running);
            Assert.Null(inspected.ExitCode);
            Assert.Equal("1", inspected.Labels["envmux.swarmtest"]);
            Assert.Empty(inspected.Ports);
            Assert.True(System.Net.IPAddress.TryParse(inspected.NetworkAddresses[network], out _));

            // The alias is how one container finds another on the session's network.
            var viaAlias = await UntilAsync(
                async () =>
                {
                    var answer = await RunAsync(engine, a, ["wget", "-qO-", "http://beta:18080/"]);
                    return answer.ExitCode == 0 ? answer : throw new InvalidOperationException(answer.Stderr);
                },
                TimeSpan.FromSeconds(20));

            Assert.Equal("i-am-beta", viaAlias.Stdout.Trim());

            var listed = await engine.ContainersAsync(Labels);
            Assert.Contains(listed, c => c.Names.Contains(a) && c.State == "running");
            Assert.All(listed, c => Assert.Equal("1", c.Labels["envmux.swarmtest"]));

            await engine.StopAsync(a, timeoutSeconds: 1);
            var stopped = await engine.InspectAsync(a);
            Assert.False(stopped!.Running);
            Assert.NotNull(stopped.ExitCode);

            // A network with a container on it will not go.
            var busy = await Assert.ThrowsAsync<DockerEngineException>(() => engine.RemoveNetworkAsync(network));
            output.WriteLine($"removing a network in use: {busy.Status} {busy.Message}");
        }
        finally
        {
            await engine.RemoveAsync(a);
            await engine.RemoveAsync(b);
            await engine.RemoveNetworkAsync(network);
        }

        Assert.Null(await engine.InspectAsync(a));
        Assert.False(await engine.RemoveAsync(a));
        Assert.False(await engine.RemoveNetworkAsync(network));
    }

    [SkippableFact]
    public async Task APublishedPortIsWrittenBoundAndReadBackStoppedOrNot()
    {
        var engine = Engine;
        var name = Name("pub");
        // macOS does not route all of 127/8 to lo0 without explicit aliases.
        // Publishing a port should not require changing the workstation's network.
        var address = OperatingSystem.IsMacOS() ? "127.0.0.1" : "127.9.1.1";

        try
        {
            await engine.CreateContainerAsync(name, new ContainerCreate
            {
                Image = DockerEngineFixture.Image,
                Cmd = ["sh", "-c", "mkdir -p /www && echo published > /www/index.html && exec httpd -f -p 18080 -h /www"],
                Labels = Labels,
                Ports = [new PortBinding(18080, address, 18080)],
            });

            var clock = Stopwatch.StartNew();
            await engine.StartAsync(name);

            using var http = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
            var answer = await UntilAsync(() => http.GetStringAsync($"http://{address}:18080/"), TimeSpan.FromSeconds(20));
            output.WriteLine($"{address}:18080 answered {clock.Elapsed.TotalMilliseconds:F0} ms after start was asked for");
            Assert.Equal("published", answer.Trim());

            Assert.Equal([new PortBinding(18080, address, 18080)], (await engine.InspectAsync(name))!.Ports);

            await engine.StopAsync(name, timeoutSeconds: 1);

            // Stopped, the bindings are still what it was created with.
            Assert.Equal([new PortBinding(18080, address, 18080)], (await engine.InspectAsync(name))!.Ports);
        }
        finally
        {
            await engine.RemoveAsync(name);
        }
    }

    [SkippableFact]
    public async Task WaitingOnAContainerGivesItsExitCodeAtOnceWhenItHasAlreadyEnded()
    {
        var engine = Engine;
        var name = Name("wait");

        try
        {
            await engine.CreateContainerAsync(name, new ContainerCreate
            {
                Image = DockerEngineFixture.Image,
                Cmd = ["sh", "-c", "sleep 1; exit 3"],
                Labels = Labels,
                Init = false,
            });

            await engine.StartAsync(name);

            var clock = Stopwatch.StartNew();
            Assert.Equal(3, await engine.WaitAsync(name));
            output.WriteLine($"wait on a running container returned in {clock.ElapsedMilliseconds} ms");
            Assert.True(clock.Elapsed > TimeSpan.FromMilliseconds(500), "the wait did not wait");

            // Already exited: at once, and the same answer.
            clock.Restart();
            Assert.Equal(3, await engine.WaitAsync(name));
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(2));

            var gone = await Assert.ThrowsAsync<DockerEngineException>(() => engine.WaitAsync(Name("no-such")));
            Assert.True(gone.IsNotFound);
        }
        finally
        {
            await engine.RemoveAsync(name);
        }
    }

    [SkippableFact]
    public async Task ATerminalExecRoundTrips()
    {
        var engine = Engine;
        var name = Name("tty");

        try
        {
            await StartSleeperAsync(engine, name);

            var id = await engine.ExecCreateAsync(name, new ExecCreate
            {
                Cmd = ["sh"],
                Tty = true,
                AttachStdin = true,
                ConsoleSize = (100, 30),
                Env = new Dictionary<string, string> { ["PS1"] = "$ " },
            });

            await using var stream = await engine.ExecStartAsync(id, tty: true);
            var seen = new StringBuilder();

            await stream.WriteAsync("stty size; echo h''i\n"u8.ToArray());
            await ReadUntilAsync(stream, seen, s => s.Contains("30 100", StringComparison.Ordinal) && s.Contains("\nhi", StringComparison.Ordinal));

            Assert.True((await engine.ExecInspectAsync(id)).Running);

            await engine.ExecResizeAsync(id, columns: 132, rows: 43);
            await stream.WriteAsync("stty size\n"u8.ToArray());
            await ReadUntilAsync(stream, seen, s => s.Contains("43 132", StringComparison.Ordinal));

            await stream.WriteAsync("exit 3\n"u8.ToArray());

            // The process exiting is the end of the stream, and not a hang.
            await ReadUntilAsync(stream, seen, _ => false);

            var after = await UntilAsync(
                async () =>
                {
                    var inspect = await engine.ExecInspectAsync(id);
                    return inspect.Running ? throw new InvalidOperationException("still running") : inspect;
                },
                TimeSpan.FromSeconds(5));

            Assert.Equal(3, after.ExitCode);
        }
        finally
        {
            await engine.RemoveAsync(name);
        }
    }

    [SkippableFact]
    public async Task WithoutATerminalStdoutAndStderrComeApartAndStdinCanEnd()
    {
        var engine = Engine;
        var name = Name("pipe");

        try
        {
            await StartSleeperAsync(engine, name);

            var both = await RunAsync(engine, name, ["sh", "-c", "echo to-out; echo to-err >&2; exit 2"]);
            Assert.Equal("to-out\n", both.Stdout);
            Assert.Equal("to-err\n", both.Stderr);
            Assert.Equal(2, both.ExitCode);

            // A push: cat ends when its input does, and the connection stays up
            // for what it says afterwards. Binary, and bigger than one pipe buffer.
            var payload = new byte[300_000];
            new Random(7).NextBytes(payload);

            var pushed = await RunAsync(engine, name, ["sh", "-c", "cat > /tmp/pushed && wc -c < /tmp/pushed"], stdin: payload);
            Assert.Equal(0, pushed.ExitCode);
            Assert.Equal("300000", pushed.Stdout.Trim());

            var user = await RunAsync(engine, name, ["sh", "-c", "id -u; pwd; echo $GREETING"]);
            Assert.Equal("0\n/\n\n", user.Stdout);

            var id = await engine.ExecCreateAsync(name, new ExecCreate
            {
                Cmd = ["sh", "-c", "id -u; pwd; echo $GREETING"],
                User = "nobody",
                WorkingDir = "/tmp",
                Env = new Dictionary<string, string> { ["GREETING"] = "kia ora" },
            });

            using var stdout = new MemoryStream();

            await using (var stream = await engine.ExecStartAsync(id, tty: false))
            {
                await StdCopyReader.CopyAsync(stream, stdout, null);
            }

            Assert.Equal("65534\n/tmp\nkia ora\n", Encoding.UTF8.GetString(stdout.ToArray()));

            // The engine's refusals arrive as its own sentences, through the hand-written request too.
            var gone = await Assert.ThrowsAsync<DockerEngineException>(() => engine.ExecStartAsync(new string('0', 64), tty: false));
            output.WriteLine($"starting an exec that does not exist: {gone.Status} {gone.Message}");
            Assert.True(gone.IsNotFound);

            var nowhere = await Assert.ThrowsAsync<DockerEngineException>(
                () => engine.ExecCreateAsync(Name("no-such"), new ExecCreate { Cmd = ["true"] }));
            Assert.True(nowhere.IsNotFound);
            Assert.Contains("No such container", nowhere.Message, StringComparison.Ordinal);
        }
        finally
        {
            await engine.RemoveAsync(name);
        }
    }

    [SkippableFact]
    public async Task AnArchiveGoesInAndComesBackOut()
    {
        var engine = Engine;
        var name = Name("files");
        var volume = Name("vol");

        try
        {
            await engine.CreateVolumeAsync(volume, Labels);
            await engine.CreateVolumeAsync(volume, Labels); // there already is not an error

            Assert.Contains(await engine.VolumesAsync(Labels), v => v.Name == volume && v.Labels["envmux.swarmtest"] == "1");

            await engine.CreateContainerAsync(name, new ContainerCreate
            {
                Image = DockerEngineFixture.Image,
                Cmd = ["sleep", "600"],
                Labels = Labels,
                Mounts = [new MountSpec("volume", volume, "/work"), new MountSpec("tmpfs", "", "/scratch")],
            });

            await engine.StartAsync(name);

            using var tar = new MemoryStream();

            await using (var writer = new TarWriter(tar, TarEntryFormat.Pax, leaveOpen: true))
            {
                await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.Directory, "nest"));

                await writer.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, "nest/hello.txt")
                {
                    DataStream = new MemoryStream("kia ora\n"u8.ToArray()),
                    Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
                });
            }

            tar.Position = 0;
            await engine.PutArchiveAsync(name, "/work", tar);

            var seen = await RunAsync(engine, name, ["sh", "-c", "cat /work/nest/hello.txt; stat -c %a /work/nest/hello.txt"]);
            Assert.Equal("kia ora\n700\n", seen.Stdout);

            // The one-entry archive DockerFiles sends: unpacked at /, directories made on the way, owned by root.
            var files = new DockerFiles(engine);
            await files.PushAsync(name, "/work/deep/er/pushed.txt", "pushed\n"u8.ToArray(), "0600");

            var pushed = await RunAsync(engine, name, ["sh", "-c", "cat /work/deep/er/pushed.txt; stat -c '%a %u' /work/deep/er/pushed.txt"]);
            Assert.Equal("pushed\n600 0\n", pushed.Stdout);

            Assert.Equal("pushed\n"u8.ToArray(), await files.PullAsync(name, "/work/deep/er/pushed.txt"));
            Assert.Null(await files.PullAsync(name, "/work/not-there"));

            // A link is followed, the way cat would.
            await RunAsync(engine, name, ["ln", "-s", "deep/er/pushed.txt", "/work/link"]);
            Assert.Equal("pushed\n"u8.ToArray(), await files.PullAsync(name, "/work/link"));

            await using (var back = await engine.GetArchiveAsync(name, "/work/nest"))
            {
                Assert.NotNull(back);

                var found = new Dictionary<string, string>(StringComparer.Ordinal);
                await using var reader = new TarReader(back);

                while (await reader.GetNextEntryAsync() is { } entry)
                {
                    using var text = new MemoryStream();

                    if (entry.DataStream is not null)
                    {
                        await entry.DataStream.CopyToAsync(text);
                    }

                    found[entry.Name.TrimEnd('/')] = Encoding.UTF8.GetString(text.ToArray());
                }

                Assert.Equal("kia ora\n", found["nest/hello.txt"]);
            }

            Assert.Null(await engine.GetArchiveAsync(name, "/work/not-there"));

            var wrong = await Assert.ThrowsAsync<DockerEngineException>(() => engine.GetArchiveAsync(Name("no-such"), "/work"));
            Assert.True(wrong.IsNotFound);

            var inspected = await engine.InspectAsync(name);
            Assert.Contains(new MountSpec("volume", volume, "/work"), inspected!.Mounts);
            Assert.Contains(new MountSpec("tmpfs", "", "/scratch"), inspected.Mounts);

            // In use, a volume will not go; the engine says so and says by whom.
            var busy = await Assert.ThrowsAsync<DockerEngineException>(() => engine.RemoveVolumeAsync(volume));
            output.WriteLine($"removing a volume in use: {busy.Status} {busy.Message}");
            Assert.True(busy.IsConflict);

            // The container is cattle and the volume is the state: gone and recreated, the file is still there.
            await engine.RemoveAsync(name);

            await engine.CreateContainerAsync(name, new ContainerCreate
            {
                Image = DockerEngineFixture.Image,
                Cmd = ["sleep", "600"],
                Labels = Labels,
                Mounts = [new MountSpec("volume", volume, "/work", ReadOnly: true)],
            });

            await engine.StartAsync(name);

            var kept = await RunAsync(engine, name, ["sh", "-c", "cat /work/nest/hello.txt; touch /work/x"]);
            Assert.Equal("kia ora\n", kept.Stdout);
            Assert.Contains("Read-only", kept.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            await engine.RemoveAsync(name);
            await engine.RemoveVolumeAsync(volume);
        }

        Assert.False(await engine.RemoveVolumeAsync(volume));
    }

    /// <summary>
    /// The name is the claim: of everyone who asks for one at once, exactly one is told yes.
    /// </summary>
    [SkippableFact]
    public async Task OfManyWhoCreateOneNetworkNameAtOnceExactlyOneWins()
    {
        var engine = Engine;
        const int Rounds = 4;
        const int Racers = 8;

        // Separate clients, so the racers are separate connections and not one pool being polite.
        var clients = Enumerable.Range(0, Racers).Select(_ => DockerEngineClient.Connect()).ToArray();

        try
        {
            foreach (var client in clients)
            {
                await client.VersionAsync();
            }

            for (var round = 0; round < Rounds; round++)
            {
                var name = Name($"race-{round.ToString(CultureInfo.InvariantCulture)}");

                try
                {
                    using var gate = new ManualResetEventSlim();

                    var racers = clients
                        .Select(client => Task.Run(async () =>
                        {
                            gate.Wait();
                            return await client.CreateNetworkAsync(name, Labels);
                        }))
                        .ToArray();

                    gate.Set();
                    var answers = await Task.WhenAll(racers);

                    var mine = (await engine.NetworksAsync(Labels)).Count(n => n.Name == name);
                    output.WriteLine($"round {round}: {answers.Count(won => won)} of {Racers} told yes; {mine} network(s) of that name exist");

                    Assert.Equal(1, answers.Count(won => won));
                    Assert.Equal(1, mine);
                }
                finally
                {
                    // By name, until the name is gone: if the engine ever did make two, neither is left behind.
                    while (await engine.RemoveNetworkAsync(name))
                    {
                    }
                }
            }
        }
        finally
        {
            foreach (var client in clients)
            {
                await client.DisposeAsync();
            }
        }
    }

    /// <summary>
    /// A network with its own subnet: the same name again is a lost claim, and
    /// the same addresses under another name is the engine refusing the overlap.
    /// </summary>
    [SkippableFact]
    public async Task ANetworkWithItsOwnSubnetIsMadeOnceAndItsAddressesAreNotGivenOutTwice()
    {
        var engine = Engine;
        var a = Name("subnet-a");
        var b = Name("subnet-b");
        const string Subnet = "10.213.250.0/24";

        try
        {
            Assert.True(await engine.CreateNetworkAsync(a, Labels, Subnet, "10.213.250.254"));

            // The same name, the same subnet: what a racer who lost is told.
            // Whether that is a 409 (false) or the overlap's 403 (thrown) is
            // the engine's choice, and this run writes down which.
            try
            {
                var again = await engine.CreateNetworkAsync(a, Labels, Subnet, "10.213.250.254");
                output.WriteLine($"the same name and subnet again: returned {again}");
                Assert.False(again);
            }
            catch (DockerEngineException e)
            {
                output.WriteLine($"the same name and subnet again: threw {e.Status} {e.Message}");
            }

            Assert.Equal(1, (await engine.NetworksAsync(Labels)).Count(n => n.Name == a));

            // Another name on the same addresses is not a lost race: it is a refusal.
            var overlap = await Assert.ThrowsAsync<DockerEngineException>(() => engine.CreateNetworkAsync(b, Labels, Subnet));
            output.WriteLine($"another name on the same subnet: {overlap.Status} {overlap.Message}");
            Assert.Equal(403, overlap.Status);
            Assert.DoesNotContain(await engine.NetworksAsync(Labels), n => n.Name == b);

            // A container on it takes an address from that subnet.
            var name = Name("subnet-c");

            try
            {
                await engine.CreateContainerAsync(name, new ContainerCreate
                {
                    Image = DockerEngineFixture.Image,
                    Cmd = ["sleep", "600"],
                    Labels = Labels,
                    Network = a,
                });

                await engine.StartAsync(name);

                var address = (await engine.InspectAsync(name))!.NetworkAddresses[a];
                output.WriteLine($"a container on {Subnet} got {address}");
                Assert.StartsWith("10.213.250.", address, StringComparison.Ordinal);
            }
            finally
            {
                await engine.RemoveAsync(name);
            }
        }
        finally
        {
            await engine.RemoveNetworkAsync(b);
            await engine.RemoveNetworkAsync(a);
        }
    }

    [SkippableFact]
    public async Task AnImageIsBuiltFromATarListedByLabelCommittedFromAContainerAndRemoved()
    {
        var engine = Engine;
        var built = $"{Name("built")}:1";
        var committed = Name("committed");
        var container = Name("from-built");

        try
        {
            var lines = new List<string>();

            await engine.BuildAsync(
                Context($"FROM {DockerEngineFixture.Image}\nRUN echo built-by-envmux > /built.txt\n"),
                built,
                Labels,
                lines.Add);

            output.WriteLine(string.Join('\n', lines));
            Assert.Contains(lines, l => l.StartsWith("Step 2/", StringComparison.Ordinal) || l.Contains("RUN echo", StringComparison.Ordinal));

            var image = await engine.ImageAsync(built);
            Assert.NotNull(image);
            Assert.Contains(built, image.RepoTags);
            Assert.Equal("1", image.Labels["envmux.swarmtest"]);
            Assert.NotNull(image.Created);

            // Listed by label, with the same labels and a date, which is what prune reads.
            var listed = await engine.ImagesAsync(Labels);
            var row = Assert.Single(listed, i => i.RepoTags.Contains(built));
            Assert.Equal(image.Id, row.Id);
            Assert.Equal("1", row.Labels["envmux.swarmtest"]);
            Assert.NotNull(row.Created);
            Assert.True((row.Created.Value - image.Created.Value).Duration() < TimeSpan.FromSeconds(2));

            // The same filter with a value that matches nothing lists nothing of anybody's.
            Assert.Empty(await engine.ImagesAsync(new Dictionary<string, string> { ["envmux.swarmtest"] = fixture.Run }));

            // A build that fails has already answered 200; the failure is a line, and must come back as one.
            var failed = await Assert.ThrowsAsync<DockerEngineException>(() => engine.BuildAsync(
                Context($"FROM {DockerEngineFixture.Image}\nRUN echo about-to-fail && exit 7\n"),
                $"{Name("never")}:1",
                Labels));

            output.WriteLine($"a failing build: {failed.Message}");
            Assert.Contains("7", failed.Message, StringComparison.Ordinal);
            Assert.Null(await engine.ImageAsync($"{Name("never")}:1"));

            await engine.CreateContainerAsync(container, new ContainerCreate
            {
                Image = built,
                Cmd = ["sleep", "600"],
                Labels = Labels,
            });

            await engine.StartAsync(container);
            Assert.Equal(0, (await RunAsync(engine, container, ["sh", "-c", "echo added-later > /later.txt"])).ExitCode);

            var id = await engine.CommitAsync(container, committed, "snap");
            Assert.StartsWith("sha256:", id, StringComparison.Ordinal);

            var snapshot = await engine.ImageAsync($"{committed}:snap");
            Assert.NotNull(snapshot);
            Assert.Equal(id, snapshot.Id);

            await engine.RemoveAsync(container);

            await engine.CreateContainerAsync(container, new ContainerCreate
            {
                Image = $"{committed}:snap",
                Cmd = ["cat", "/built.txt", "/later.txt"],
                Labels = Labels,
                Init = false,
            });

            await engine.StartAsync(container);
            Assert.Equal(0, await engine.WaitAsync(container));

            var missing = await Assert.ThrowsAsync<DockerEngineException>(() => engine.CreateContainerAsync(Name("no-image"), new ContainerCreate
            {
                Image = $"{Name("not-an-image")}:0",
                Labels = Labels,
            }));

            output.WriteLine($"creating from an image that is not there: {missing.Status} {missing.Message}");
            Assert.True(missing.IsNotFound);
        }
        finally
        {
            await engine.RemoveAsync(container);
            await engine.RemoveAsync(Name("no-image"));
            await engine.RemoveImageAsync($"{committed}:snap");
            await engine.RemoveImageAsync(built);
            await engine.RemoveImageAsync($"{Name("never")}:1");
        }

        Assert.Null(await engine.ImageAsync(built));
        Assert.False(await engine.RemoveImageAsync(built));
    }

    [SkippableFact]
    public async Task APullReportsItsLayersAndAnImageThatIsNotThereIsAFailure()
    {
        var engine = Engine;
        var lines = new List<string>();

        // Already here — the fixture saw to that — so this is a manifest check and no download.
        await engine.PullAsync(DockerEngineFixture.Image, lines.Add);

        output.WriteLine(string.Join('\n', lines));
        Assert.Contains(lines, l => l.Contains("Status:", StringComparison.Ordinal) || l.Contains("Digest:", StringComparison.Ordinal));

        var failed = await Assert.ThrowsAsync<DockerEngineException>(
            () => engine.PullAsync($"{DockerEngineFixture.Image.Split(':')[0]}:swarmtest-engine-no-such-tag"));

        output.WriteLine($"pulling a tag that does not exist: {failed.Status} {failed.Message}");
    }

    [Fact]
    public async Task AnEngineThatIsNotThereIsOneSentence()
    {
        var endpoint = OperatingSystem.IsWindows()
            ? "npipe:////./pipe/swarmtest-engine-nobody-home"
            : $"unix://{Path.Combine(Path.GetTempPath(), "swarmtest-engine-nobody-home.sock")}";

        await using var nobody = DockerEngineClient.Connect(endpoint);

        var clock = Stopwatch.StartNew();
        var failure = await Assert.ThrowsAsync<DockerEngineException>(() => nobody.VersionAsync());

        output.WriteLine($"{failure.Message} ({clock.ElapsedMilliseconds} ms)");
        Assert.StartsWith($"Docker is not answering on {endpoint}", failure.Message, StringComparison.Ordinal);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5));
    }

    /// <summary>A build context with a Dockerfile in it and nothing else.</summary>
    private static MemoryStream Context(string dockerfile)
    {
        var tar = new MemoryStream();

        using (var writer = new TarWriter(tar, TarEntryFormat.Pax, leaveOpen: true))
        {
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "Dockerfile")
            {
                DataStream = new MemoryStream(Encoding.UTF8.GetBytes(dockerfile)),
            });
        }

        tar.Position = 0;
        return tar;
    }

    /// <summary>A container that does nothing, for something to exec into.</summary>
    private static async Task StartSleeperAsync(DockerEngineClient engine, string name)
    {
        await engine.CreateContainerAsync(name, new ContainerCreate
        {
            Image = DockerEngineFixture.Image,
            Cmd = ["sleep", "600"],
            Labels = Labels,
        });

        await engine.StartAsync(name);
    }

    /// <summary>Run to completion without a terminal, and take the output apart.</summary>
    private static async Task<(int? ExitCode, string Stdout, string Stderr)> RunAsync(
        DockerEngineClient engine,
        string container,
        IReadOnlyList<string> command,
        byte[]? stdin = null)
    {
        var id = await engine.ExecCreateAsync(container, new ExecCreate { Cmd = command, AttachStdin = stdin is not null });

        using var stdout = new MemoryStream();
        using var stderr = new MemoryStream();

        await using (var stream = await engine.ExecStartAsync(id, tty: false))
        {
            if (stdin is not null)
            {
                await stream.WriteAsync(stdin);
                await ((IHalfClose)stream).CompleteWriteAsync();
            }

            using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await StdCopyReader.CopyAsync(stream, stdout, stderr, patience.Token);
        }

        var inspect = await engine.ExecInspectAsync(id);

        return (inspect.ExitCode, Encoding.UTF8.GetString(stdout.ToArray()), Encoding.UTF8.GetString(stderr.ToArray()));
    }

    /// <summary>Read into <paramref name="seen"/> until it satisfies, or the stream ends.</summary>
    private static async Task ReadUntilAsync(Stream stream, StringBuilder seen, Func<string, bool> until)
    {
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var buffer = new byte[4096];

        while (!until(seen.ToString()))
        {
            int read;

            try
            {
                read = await stream.ReadAsync(buffer, patience.Token);
            }
            catch (OperationCanceledException)
            {
                throw new TimeoutException($"waited twenty seconds; what had arrived was: {seen}");
            }

            if (read == 0)
            {
                return;
            }

            seen.Append(Encoding.UTF8.GetString(buffer, 0, read));
        }
    }

    private static async Task<T> UntilAsync<T>(Func<Task<T>> attempt, TimeSpan within)
    {
        var clock = Stopwatch.StartNew();

        while (true)
        {
            try
            {
                return await attempt();
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException or IOException)
            {
                if (clock.Elapsed > within)
                {
                    throw;
                }

                await Task.Delay(25);
            }
        }
    }
}
