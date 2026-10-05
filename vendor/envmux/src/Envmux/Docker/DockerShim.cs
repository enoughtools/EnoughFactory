using System.Globalization;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Docker;

/// <summary>
/// A Docker-compatible API over the envmux host, so VS Code's Dev Containers
/// extension attaches to an Incus instance believing it is a container.
/// </summary>
/// <remarks>
/// <para>
/// The integration surface of docs/vscode-remote.md. Every call the extension
/// makes is translated into something envmux already does against the host: a
/// container is an instance cloned from the golden snapshot, exec rides the
/// Incus exec websockets re-framed as a Docker hijack, and the connection to
/// the editor's server rides that exec rather than any published port.
/// </para>
/// <para>
/// Only what the extension actually calls is implemented — the set was captured
/// empirically (§11.1), and the handlers here are that set. The translator is
/// this class; the transport under it (<see cref="ShimEndpoint"/>) and the HTTP
/// (<see cref="ShimHttp"/>) are separate so the same translator serves a
/// Windows pipe now and a unix socket later without change.
/// </para>
/// </remarks>
internal sealed class DockerShim
{
    public const string ApiVersion = "1.47";

    public const string EngineVersion = "27.5.1-envmux";

    private readonly IncusApi _api;
    private readonly HostConfig _host;
    private readonly ShimState _state;
    private readonly Action<string> _log;
    private readonly List<ShimResponse> _eventListeners = [];
    private readonly Lock _listenerGate = new();

    public DockerShim(IncusApi api, HostConfig host, ShimState state, Action<string>? log = null)
    {
        _api = api;
        _host = host;
        _state = state;
        _log = log ?? (_ => { });
    }

    /// <summary>One request. On a hijack, the returned task owns the connection until the exec ends.</summary>
    public async Task HandleAsync(ShimRequest request, ShimResponse response, IShimConnection connection, CancellationToken ct)
    {
        var path = request.Path;

        switch (request.Method, First(path))
        {
            case ("GET", "_ping") or ("HEAD", "_ping"):
                await PingAsync(request, response, ct).ConfigureAwait(false);
                return;

            case ("GET", "version"):
                await response.JsonAsync(Version(), ct).ConfigureAwait(false);
                return;

            case ("GET", "info"):
                await response.JsonAsync(await InfoAsync(ct).ConfigureAwait(false), ct).ConfigureAwait(false);
                return;

            case ("GET", "events"):
                await EventsAsync(request, response, ct).ConfigureAwait(false);
                return;

            case (_, "images"):
                await ImagesAsync(request, response, ct).ConfigureAwait(false);
                return;

            case (_, "volumes"):
                await VolumesAsync(request, response, ct).ConfigureAwait(false);
                return;

            case ("POST", "build"):
                await response.ErrorAsync(
                    400,
                    "envmux: targets are pre-provisioned; use an \"image\" in devcontainer.json, not a Dockerfile",
                    ct).ConfigureAwait(false);
                return;

            case (_, "networks"):
                await response.JsonAsync(Array.Empty<object>(), ct).ConfigureAwait(false);
                return;

            case (_, "containers"):
                await ContainersAsync(request, response, connection, ct).ConfigureAwait(false);
                return;

            case (_, "exec"):
                await ExecAsync(request, response, connection, ct).ConfigureAwait(false);
                return;

            default:
                return; // ShimHttp answers 404 when nothing wrote a response.
        }
    }

    // -- handshake -----------------------------------------------------------

    private static async Task PingAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        response.Headers["Docker-Experimental"] = "false";
        response.Headers["Ostype"] = "linux";
        response.Headers["Builder-Version"] = "1";
        response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";

        await response.BytesAsync(
            request.Method == "HEAD" ? [] : "OK"u8.ToArray(),
            200,
            "text/plain; charset=utf-8",
            ct).ConfigureAwait(false);
    }

    private static Dictionary<string, object> Version()
    {
        var details = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["ApiVersion"] = ApiVersion,
            ["MinAPIVersion"] = "1.24",
            ["Arch"] = "amd64",
            ["Os"] = "linux",
            ["GoVersion"] = "go1.23",
            ["GitCommit"] = "envmux",
            ["KernelVersion"] = "6.12-incus",
            ["Experimental"] = "false",
        };

        return new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["Platform"] = WireJson.Object(DockerJson.Options, ("Name", "envmux (Incus)")),
            ["Version"] = EngineVersion,
            ["ApiVersion"] = ApiVersion,
            ["MinAPIVersion"] = "1.24",
            ["Arch"] = "amd64",
            ["Os"] = "linux",
            ["GoVersion"] = "go1.23",
            ["GitCommit"] = "envmux",
            ["KernelVersion"] = "6.12-incus",

            // A bool, not a string: the docker CLI deserialises this one field
            // into a Go bool and dies on a string with a message about
            // VersionResponse.Experimental. The Details map above is all strings.
            ["Experimental"] = false,
            ["Components"] = new[]
            {
                WireJson.Object(DockerJson.Options, ("Name", "Engine"), ("Version", EngineVersion), ("Details", details)),
            },
        };
    }

    private async Task<object> InfoAsync(CancellationToken ct)
    {
        var containers = await ContainersAsync(ct).ConfigureAwait(false);
        var running = containers.Count(c => c.Running);

        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["ID"] = "envmux:" + IncusClient.Normalise(_host.Fingerprint)[..Math.Min(12, _host.Fingerprint.Length)],
            ["Containers"] = containers.Count,
            ["ContainersRunning"] = running,
            ["ContainersPaused"] = 0,
            ["ContainersStopped"] = containers.Count - running,
            ["Images"] = 1,
            ["Driver"] = "zfs",
            ["OSType"] = "linux",
            ["Architecture"] = "x86_64",
            ["OperatingSystem"] = "IncusOS (envmux)",
            ["KernelVersion"] = "6.12-incus",
            ["ServerVersion"] = EngineVersion,
            ["MemTotal"] = 0L,
            ["NCPU"] = Environment.ProcessorCount,
            ["Name"] = "envmux",
            ["DockerRootDir"] = "/var/lib/incus",
            ["CgroupDriver"] = "systemd",
            ["CgroupVersion"] = "2",
            ["DefaultRuntime"] = "runc",
            ["Warnings"] = Array.Empty<string>(),
        };
    }

    // -- images --------------------------------------------------------------

    private static async Task ImagesAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var path = request.Path;

        if (path == "/images/json")
        {
            await response.JsonAsync(Array.Empty<object>(), ct).ConfigureAwait(false);
            return;
        }

        if (path == "/images/create" && request.Method == "POST")
        {
            // Every image is the golden snapshot; the pull is instant. A stream
            // of well-formed progress lines, not an empty body (§4.2).
            var name = request["fromImage"];
            await response.StartStreamAsync(200, "application/json", ct).ConfigureAwait(false);
            await WriteJsonLineAsync(response, WireJson.Object(DockerJson.Options, ("status", $"Pulling from envmux/{name}"), ("id", "latest")), ct).ConfigureAwait(false);
            await WriteJsonLineAsync(response, WireJson.Object(DockerJson.Options, ("status", $"Every image is the golden snapshot {Golden.Source}")), ct).ConfigureAwait(false);
            await WriteJsonLineAsync(response, WireJson.Object(DockerJson.Options, ("status", $"Status: Image is up to date for {name}")), ct).ConfigureAwait(false);
            await response.EndStreamAsync(ct).ConfigureAwait(false);
            return;
        }

        if (path.EndsWith("/json", StringComparison.Ordinal))
        {
            var name = Uri.UnescapeDataString(path["/images/".Length..^"/json".Length]);
            await response.JsonAsync(ImageInspect(name), ct).ConfigureAwait(false);
        }
    }

    private static Dictionary<string, object?> ImageInspect(string name) => new Dictionary<string, object?>(StringComparer.Ordinal)
    {
        ["Id"] = "sha256:" + Sha256(name),
        ["RepoTags"] = new[] { name.Contains(':', StringComparison.Ordinal) ? name : name + ":latest" },
        ["RepoDigests"] = Array.Empty<string>(),
        ["Parent"] = "",
        ["Comment"] = "envmux golden snapshot",
        ["Created"] = "2026-01-01T00:00:00Z",
        ["Architecture"] = "amd64",
        ["Os"] = "linux",
        ["Size"] = 0,
        ["Config"] = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Env"] = new[] { "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
            ["Cmd"] = new[] { "/sbin/init" },
            ["Entrypoint"] = null,
            ["WorkingDir"] = "",
            ["Labels"] = new Dictionary<string, string>(StringComparer.Ordinal),
        },
        ["RootFS"] = WireJson.Object(DockerJson.Options, ("Type", "layers"), ("Layers", new[] { "sha256:" + Sha256(Golden.Source) })),
    };

    // -- volumes -------------------------------------------------------------

    private async Task VolumesAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var path = request.Path;

        if (path == "/volumes" && request.Method == "GET")
        {
            List<object> volumes;
            lock (_state.Volumes)
            {
                volumes = [.. _state.Volumes.Select(v => Volume(v.Key, v.Value))];
            }

            await response.JsonAsync(WireJson.Object(DockerJson.Options, ("Volumes", volumes), ("Warnings", Array.Empty<string>())), ct).ConfigureAwait(false);
            return;
        }

        if (path == "/volumes/create" && request.Method == "POST")
        {
            var body = await request.JsonAsync<VolumeCreateRequest>(ct).ConfigureAwait(false) ?? new VolumeCreateRequest();
            var name = string.IsNullOrEmpty(body.Name) ? RandomHex(32) : body.Name;
            var labels = body.Labels ?? new Dictionary<string, string>(StringComparer.Ordinal);

            lock (_state.Volumes)
            {
                _state.Volumes[name] = labels;
            }

            _state.Save();
            await response.JsonAsync(Volume(name, labels), 201, ct).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/volumes/", StringComparison.Ordinal))
        {
            var name = Uri.UnescapeDataString(path["/volumes/".Length..]);

            if (request.Method == "DELETE")
            {
                lock (_state.Volumes)
                {
                    _state.Volumes.Remove(name);
                }

                _state.Save();
                await response.EmptyAsync(204, ct).ConfigureAwait(false);
                return;
            }

            Dictionary<string, string>? labels;
            lock (_state.Volumes)
            {
                _state.Volumes.TryGetValue(name, out labels);
            }

            if (labels is null)
            {
                await response.ErrorAsync(404, $"no such volume: {name}", ct).ConfigureAwait(false);
                return;
            }

            await response.JsonAsync(Volume(name, labels), ct).ConfigureAwait(false);
        }
    }

    // There is nothing behind a volume across this boundary — the client's
    // filesystem is on another machine. A name that answers is enough (§4.2).
    private static Dictionary<string, object?> Volume(string name, IReadOnlyDictionary<string, string> labels) =>
        new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Name"] = name,
            ["Driver"] = "local",
            ["Mountpoint"] = $"/var/lib/envmux/volumes/{name}",
            ["CreatedAt"] = "2026-01-01T00:00:00Z",
            ["Labels"] = labels,
            ["Scope"] = "local",
            ["Options"] = new Dictionary<string, string>(StringComparer.Ordinal),
        };

    // -- events --------------------------------------------------------------

    private async Task EventsAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        // The devcontainers CLI opens this with a `start` filter and blocks on
        // the container's start event before it runs anything else (§4.2).
        _log($"GET /events (listener)");
        await response.StartStreamAsync(200, "application/json", ct).ConfigureAwait(false);

        lock (_listenerGate)
        {
            _eventListeners.Add(response);
        }

        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, request.Aborted);
            await Task.Delay(Timeout.InfiniteTimeSpan, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The client stopped listening, or the shim is shutting down.
        }
        finally
        {
            lock (_listenerGate)
            {
                _eventListeners.Remove(response);
            }
        }
    }

    private void Emit(string action, ShimContainer container)
    {
        var now = DateTimeOffset.UtcNow;
        var attributes = new Dictionary<string, string>(container.Labels, StringComparer.Ordinal)
        {
            ["image"] = container.Image,
            ["name"] = container.Name,
        };

        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["status"] = action,
            ["id"] = container.Id,
            ["from"] = container.Image,
            ["Type"] = "container",
            ["Action"] = action,
            ["Actor"] = WireJson.Object(DockerJson.Options, ("ID", container.Id), ("Attributes", attributes)),
            ["scope"] = "local",
            ["time"] = now.ToUnixTimeSeconds(),
            ["timeNano"] = now.ToUnixTimeMilliseconds() * 1_000_000,
        };

        List<ShimResponse> listeners;
        lock (_listenerGate)
        {
            listeners = [.. _eventListeners];
        }

        _log($"event {action} {container.Name} → {listeners.Count} listener(s)");

        foreach (var listener in listeners)
        {
            // Fire and forget: a listener that has gone will fault its own
            // write, and EventsAsync removes it when its delay unblocks.
            _ = WriteJsonLineAsync(listener, payload, CancellationToken.None);
        }
    }

    // -- containers ----------------------------------------------------------

    private async Task ContainersAsync(ShimRequest request, ShimResponse response, IShimConnection connection, CancellationToken ct)
    {
        var path = request.Path;

        if (path == "/containers/json")
        {
            await ListContainersAsync(request, response, ct).ConfigureAwait(false);
            return;
        }

        if (path == "/containers/create" && request.Method == "POST")
        {
            await CreateContainerAsync(request, response, ct).ConfigureAwait(false);
            return;
        }

        // /containers/{ref}[/verb]
        var rest = path["/containers/".Length..];
        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        var reference = Uri.UnescapeDataString(slash < 0 ? rest : rest[..slash]);
        var verb = slash < 0 ? (request.Method == "DELETE" ? "delete" : "json") : rest[(slash + 1)..];

        var container = await ResolveAsync(reference, ct).ConfigureAwait(false);

        if (container is null)
        {
            await response.ErrorAsync(404, $"No such container: {reference}", ct).ConfigureAwait(false);
            return;
        }

        switch (verb)
        {
            case "json":
                await response.JsonAsync(await InspectAsync(container, ct).ConfigureAwait(false), ct).ConfigureAwait(false);
                return;

            case "start":
                await StartContainerAsync(container, ct).ConfigureAwait(false);
                Emit("start", container);
                await response.EmptyAsync(204, ct).ConfigureAwait(false);
                return;

            case "stop" or "kill":
                await _api.StopAsync(container.Instance, ct: ct).ConfigureAwait(false);
                Emit("die", container);
                Emit("stop", container);
                await response.EmptyAsync(204, ct).ConfigureAwait(false);
                return;

            case "restart":
                await _api.StopAsync(container.Instance, ct: ct).ConfigureAwait(false);
                await StartContainerAsync(container, ct).ConfigureAwait(false);
                await response.EmptyAsync(204, ct).ConfigureAwait(false);
                return;

            case "delete":
                await _api.StopAsync(container.Instance, ct: ct).ConfigureAwait(false);
                try
                {
                    await _api.DeleteAsync(container.Instance, ct).ConfigureAwait(false);
                }
                catch (IncusException e) when (e.IsNotFound)
                {
                    // Already gone.
                }

                _state.Remove(container.Id);
                Emit("destroy", container);
                await response.EmptyAsync(204, ct).ConfigureAwait(false);
                return;

            case "wait":
                await WaitContainerAsync(container, response, request.Aborted, ct).ConfigureAwait(false);
                return;

            case "attach":
                await AttachAsync(container, response, connection, ct).ConfigureAwait(false);
                return;

            case "exec":
                await CreateExecAsync(container, request, response, ct).ConfigureAwait(false);
                return;

            case "archive":
                await ArchiveAsync(container, request, response, ct).ConfigureAwait(false);
                return;

            case "logs":
                await response.BytesAsync([], 200, "application/vnd.docker.multiplexed-stream", ct).ConfigureAwait(false);
                return;

            case "top":
                await response.JsonAsync(WireJson.Object(DockerJson.Options, ("Titles", TopTitles), ("Processes", TopProcesses)), ct).ConfigureAwait(false);
                return;

            default:
                return;
        }
    }

    private async Task ListContainersAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var all = request["all"] is "1" or "true";
        var filters = DockerFilters.Parse(request["filters"]);
        var containers = await ContainersAsync(ct).ConfigureAwait(false);

        var list = new List<object>();

        foreach (var (container, running) in containers)
        {
            if ((all || running) && DockerFilters.Matches(filters, container, running))
            {
                list.Add(Summary(container, running));
            }
        }

        _log($"GET /containers/json → {list.Count}");
        await response.JsonAsync(list, ct).ConfigureAwait(false);
    }

    private async Task CreateContainerAsync(ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var body = await request.JsonAsync<ContainerCreateRequest>(ct).ConfigureAwait(false)
            ?? throw new ShimProtocolException("empty create body");

        var labels = body.Labels ?? new Dictionary<string, string>(StringComparer.Ordinal);
        var localFolder = labels.GetValueOrDefault("devcontainer.local_folder", "");
        var name = request["name"];

        var basis = name.Length > 0 ? name
            : localFolder.Length > 0 ? Path.GetFileName(localFolder.Replace('\\', '/').TrimEnd('/'))
            : "workspace";

        var slug = Config.Slug.From(basis);
        var instance = $"vsc-{(slug.Length > 0 ? slug : "workspace")}-{RandomHex(4)}";
        var id = Sha256(instance);

        // Marked as ours, so prune sees it and the golden-clone path recognises
        // it. The docker id is kept so the mapping survives a lost state file
        // enough to be diagnosable.
        var config = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [InstanceSpec.Keys.Schema] = InstanceSpec.Keys.SchemaVersion,
            [InstanceSpec.Keys.Project] = slug,
            [InstanceSpec.Keys.Created] = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
        };

        if (localFolder.Length > 0)
        {
            config[InstanceSpec.Keys.Directory] = localFolder;
        }

        _log($"POST /containers/create → cloning {Golden.Source} → {instance}");

        await _api.CreateAsync(
            new InstancesPost
            {
                Name = instance,
                Description = $"envmux: VS Code dev container for {(localFolder.Length > 0 ? localFolder : slug)}",
                Source = new InstanceSource { Type = "copy", Source = Golden.Source },
                Config = config,
                Devices = InstanceSpec.Attached(_host),
                Start = false,
            },
            ct: ct).ConfigureAwait(false);

        var container = new ShimContainer
        {
            Id = id,
            Name = name.Length > 0 ? name : instance,
            Instance = instance,
            Created = DateTimeOffset.UtcNow,
            Labels = new Dictionary<string, string>(labels, StringComparer.Ordinal),
            Image = body.Image.Length > 0 ? body.Image : "envmux",
            Cmd = body.Cmd,
            Entrypoint = body.Entrypoint,
            Env = body.Env ?? [],
            User = body.User ?? "",
            WorkingDir = body.WorkingDir ?? "",
            Mounts = Mounts(body.HostConfig),
        };

        _state.Put(container);
        Emit("create", container);
        await response.JsonAsync(WireJson.Object(DockerJson.Options, ("Id", id), ("Warnings", Array.Empty<string>())), 201, ct).ConfigureAwait(false);
    }

    private static List<ShimMount> Mounts(HostConfigRequest? hostConfig)
    {
        if (hostConfig is null)
        {
            return [];
        }

        var mounts = new List<ShimMount>();

        foreach (var mount in hostConfig.Mounts ?? [])
        {
            mounts.Add(new ShimMount(mount.Type.Length > 0 ? mount.Type : "bind", mount.Source, mount.Target, !mount.ReadOnly));
        }

        foreach (var bind in hostConfig.Binds ?? [])
        {
            // host:container[:opts] — the host half may carry a drive colon, so
            // the destination is the first component that begins with a slash.
            var parts = bind.Split(':');
            var destination = parts.Skip(1).FirstOrDefault(p => p.StartsWith('/')) ?? "";

            if (destination.Length > 0)
            {
                var source = bind[..bind.LastIndexOf(":" + destination, StringComparison.Ordinal)];
                mounts.Add(new ShimMount("bind", source, destination, true));
            }
        }

        return mounts;
    }

    private async Task StartContainerAsync(ShimContainer container, CancellationToken ct)
    {
        var state = await _api.StateAsync(container.Instance, ct).ConfigureAwait(false);

        if (state is not { IsRunning: true })
        {
            _log($"start {container.Instance}");
            await _api.StartAsync(container.Instance, ct).ConfigureAwait(false);
        }

        var address = await _api.AwaitAddressAsync(container.Instance, TimeSpan.FromSeconds(60), ct).ConfigureAwait(false)
            ?? throw new ShimException($"{container.Instance} did not take an address");

        _log($"start {container.Instance} is up at {address}");

        // No bind mounts cross this boundary (§9): the workspace lives on the
        // target. Provision the workspace directories the client asked to mount.
        foreach (var mount in container.Mounts)
        {
            if (!mount.Destination.StartsWith("/workspaces/", StringComparison.Ordinal))
            {
                continue;
            }

            var readme =
                $"# {Path.GetFileName(mount.Destination)}\n\n" +
                $"This workspace lives in the Incus instance `{container.Instance}`, cloned from `{Golden.Source}`.\n" +
                $"The local folder the editor was opened on was `{mount.Source}`, which is not bind-mounted " +
                "(docs/vscode-remote.md §9).\n";

            var script =
                $"mkdir -p {Workspace.Quote(mount.Destination)} && " +
                $"[ -n \"$(ls -A {Workspace.Quote(mount.Destination)})\" ] || " +
                $"printf '%s' {Workspace.Quote(readme)} > {Workspace.Quote(mount.Destination + "/README.md")}";

            await Command.CaptureAsync(_api, container.Instance, ["sh", "-c", script], ct: ct).ConfigureAwait(false);
        }
    }

    private async Task WaitContainerAsync(ShimContainer container, ShimResponse response, CancellationToken aborted, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(aborted, ct);

        try
        {
            while (!linked.IsCancellationRequested)
            {
                var state = await _api.StateAsync(container.Instance, linked.Token).ConfigureAwait(false);

                if (state is not { IsRunning: true })
                {
                    break;
                }

                await Task.Delay(TimeSpan.FromSeconds(2), linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            return;
        }

        await response.JsonAsync(WireJson.Object(DockerJson.Options, ("StatusCode", 0)), ct).ConfigureAwait(false);
    }

    // -- attach --------------------------------------------------------------

    private async Task AttachAsync(ShimContainer container, ShimResponse response, IShimConnection connection, CancellationToken ct)
    {
        // `docker run` is create → attach → wait → start; the CLI waits on the
        // attach stream for the first line of its own entrypoint (§ Findings 6),
        // which does not run because the instance's init is systemd. So the
        // entrypoint's echo is replayed once the instance is up.
        _log($"attach {container.Instance} (holding)");
        var io = await response.HijackAsync(tty: false, ct).ConfigureAwait(false);

        var line = EntrypointEcho(container) ?? "Container started";

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var state = await _api.StateAsync(container.Instance, ct).ConfigureAwait(false);

                if (state is { IsRunning: true })
                {
                    var frame = StdCopy.Frame(StdCopy.Stdout, Encoding.UTF8.GetBytes(line + "\n"));
                    await io.WriteAsync(frame, ct).ConfigureAwait(false);
                    await io.FlushAsync(ct).ConfigureAwait(false);
                    _log($"attach said \"{line}\"");
                    break;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(250), ct).ConfigureAwait(false);
            }

            // Hold the stream: the CLI keeps it as the container's stdout with
            // --sig-proxy=false, and closing it early reads as the container
            // exiting. It ends when the client disconnects or the shim stops.
            var idle = new byte[1];

            while (!ct.IsCancellationRequested)
            {
                if (await io.ReadAsync(idle, ct).ConfigureAwait(false) == 0)
                {
                    break;
                }
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException)
        {
            // The client went away, which is the end of the attach.
        }
        finally
        {
            await connection.CompleteWriteAsync(CancellationToken.None).ConfigureAwait(false);
        }
    }

    private static readonly char[] EchoStops = [';', '\n'];

    private static string? EntrypointEcho(ShimContainer container)
    {
        var command = string.Join(' ', (container.Entrypoint ?? []).Concat(container.Cmd ?? []));
        var index = command.IndexOf("echo ", StringComparison.Ordinal);

        if (index < 0)
        {
            return null;
        }

        var rest = command[(index + 5)..];
        var end = rest.IndexOfAny(EchoStops);
        return (end < 0 ? rest : rest[..end]).Trim().Trim('"', '\'');
    }

    // -- exec ----------------------------------------------------------------

    private static readonly string[] TopTitles = ["PID", "USER", "COMMAND"];

    private static readonly string[][] TopProcesses = [["1", "root", "/sbin/init"]];

    private readonly Dictionary<string, PendingExec> _execs = new(StringComparer.Ordinal);
    private readonly Lock _execGate = new();

    private sealed record PendingExec(string Instance, ExecCreateRequest Request)
    {
        public bool Running { get; set; }

        public int? ExitCode { get; set; }
    }

    private async Task CreateExecAsync(ShimContainer container, ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var body = await request.JsonAsync<ExecCreateRequest>(ct).ConfigureAwait(false)
            ?? throw new ShimProtocolException("empty exec body");

        var id = RandomHex(32);

        lock (_execGate)
        {
            _execs[id] = new PendingExec(container.Instance, body);
        }

        _log($"exec create {id[..8]} tty={body.Tty} cmd={WireJson.Serialize(body.Cmd)}");
        await response.JsonAsync(WireJson.Object(DockerJson.Options, ("Id", id)), 201, ct).ConfigureAwait(false);
    }

    private async Task ExecAsync(ShimRequest request, ShimResponse response, IShimConnection connection, CancellationToken ct)
    {
        var rest = request.Path["/exec/".Length..];
        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        var id = slash < 0 ? rest : rest[..slash];
        var verb = slash < 0 ? "" : rest[(slash + 1)..];

        PendingExec? pending;
        lock (_execGate)
        {
            _execs.TryGetValue(id, out pending);
        }

        if (pending is null)
        {
            await response.ErrorAsync(404, $"No such exec instance: {id}", ct).ConfigureAwait(false);
            return;
        }

        switch (verb)
        {
            case "json":
                await response.JsonAsync(new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ID"] = id,
                    ["Running"] = pending.Running,
                    ["ExitCode"] = pending.ExitCode,
                    ["ProcessConfig"] = WireJson.Object(DockerJson.Options,
                        ("tty", pending.Request.Tty),
                        ("entrypoint", pending.Request.Cmd.Count > 0 ? pending.Request.Cmd[0] : ""),
                        ("arguments", pending.Request.Cmd.Skip(1).ToArray()),
                        ("user", pending.Request.User ?? "")),
                    ["OpenStdin"] = pending.Request.AttachStdin,
                    ["OpenStdout"] = true,
                    ["OpenStderr"] = true,
                }, ct).ConfigureAwait(false);
                return;

            case "start":
                await StartExecAsync(id, pending, request, response, connection, ct).ConfigureAwait(false);
                return;

            default:
                return;
        }
    }

    private async Task StartExecAsync(string id, PendingExec pending, ShimRequest request, ShimResponse response, IShimConnection connection, CancellationToken ct)
    {
        // Read the body in every case, upgrade included: on a hijack its bytes
        // sit in the same connection the stream is taken over, and anything left
        // unread would be delivered as the first bytes of stdin.
        var body = await request.JsonAsync<ExecStartRequest>(ct).ConfigureAwait(false) ?? new ExecStartRequest();

        var tty = pending.Request.Tty || body.Tty;

        var exec = await DockerExec.StartAsync(
            _api,
            pending.Instance,
            pending.Request.Cmd,
            tty,
            pending.Request.Environment(),
            pending.Request.User,
            string.IsNullOrEmpty(pending.Request.WorkingDir) ? null : pending.Request.WorkingDir,
            width: 200,
            height: 50,
            ct: ct).ConfigureAwait(false);

        pending.Running = true;
        _log($"exec {id[..8]} started (op {exec.OperationId[..Math.Min(8, exec.OperationId.Length)]}, tty={tty})");

        if (!request.WantsUpgrade)
        {
            // A detached start: run it out of band, answer 200 now.
            await response.EmptyAsync(200, ct).ConfigureAwait(false);
            _ = Task.Run(async () =>
            {
                try
                {
                    pending.ExitCode = await exec.CollectAsync(CancellationToken.None).ConfigureAwait(false) is { } r ? r.ExitCode : 0;
                }
                finally
                {
                    pending.Running = false;
                    await exec.DisposeAsync().ConfigureAwait(false);
                }
            }, CancellationToken.None);
            return;
        }

        var io = await response.HijackAsync(tty, ct).ConfigureAwait(false);

        try
        {
            pending.ExitCode = await ExecBridge.RunAsync(connection, io, exec, ct).ConfigureAwait(false);
        }
        finally
        {
            pending.Running = false;
            await exec.DisposeAsync().ConfigureAwait(false);
        }

        _log($"exec {id[..8]} exited {pending.ExitCode}");
    }

    // -- archive -------------------------------------------------------------

    private async Task ArchiveAsync(ShimContainer container, ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        var target = request["path"];
        _log($"archive {request.Method} {target}");

        if (request.Method is "HEAD" or "GET")
        {
            var stat = await StatAsync(container.Instance, target, ct).ConfigureAwait(false);

            if (stat is null)
            {
                // A HEAD carries no body, ever — the stat is reported by status
                // alone. A body on a HEAD is read as the next response and
                // poisons the kept-alive connection ("Unsolicited response").
                if (request.Method == "HEAD")
                {
                    await response.EmptyAsync(404, ct).ConfigureAwait(false);
                }
                else
                {
                    await response.ErrorAsync(404, $"Could not find {target} in {container.Id[..12]}", ct).ConfigureAwait(false);
                }

                return;
            }

            response.Headers["X-Docker-Container-Path-Stat"] = stat;

            if (request.Method == "HEAD")
            {
                await response.EmptyAsync(200, ct).ConfigureAwait(false);
                return;
            }

            await StreamTarOutAsync(container.Instance, target, response, ct).ConfigureAwait(false);
            return;
        }

        if (request.Method == "PUT")
        {
            await ExtractTarInAsync(container.Instance, target, request, response, ct).ConfigureAwait(false);
            return;
        }

        await response.ErrorAsync(405, "method not allowed", ct).ConfigureAwait(false);
    }

    private async Task<string?> StatAsync(string instance, string path, CancellationToken ct)
    {
        var result = await Command.CaptureAsync(_api, instance, ["stat", "-c", "%F|%s|%a|%Y|%n", path], ct: ct).ConfigureAwait(false);

        if (!result.Ok)
        {
            return null;
        }

        var fields = result.Text.Trim().Split('|');

        if (fields.Length < 5)
        {
            return null;
        }

        var kind = fields[0];
        var size = long.TryParse(fields[1], out var s) ? s : 0;
        var mode = Convert.ToInt32(fields[2], 8);
        var mtime = long.TryParse(fields[3], out var t) ? t : 0;

        // Go's fs.FileMode: the low bits are the permission bits, and the high
        // bits are type flags — directory is bit 31, symlink is bit 27.
        var goMode = (uint)mode;

        if (kind.Contains("directory", StringComparison.Ordinal))
        {
            goMode |= 1u << 31;
        }

        var stat = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["name"] = Path.GetFileName(path.TrimEnd('/')),
            ["size"] = size,
            ["mode"] = goMode,
            // Canonical RFC3339 with a Z and milliseconds — what the Go client's
            // time.Time decode expects. The round-trip ("o") form, with seven
            // fractional digits and a numeric offset, fails that decode, and a
            // failed stat decode reads as the path not existing: `docker cp` into
            // a directory then reports "no such directory".
            ["mtime"] = DateTimeOffset.FromUnixTimeSeconds(mtime).UtcDateTime
                .ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            ["linkTarget"] = "",
        };

        return Convert.ToBase64String(WireJson.SerializeToUtf8Bytes(stat, DockerJson.Options));
    }

    private async Task StreamTarOutAsync(string instance, string path, ShimResponse response, CancellationToken ct)
    {
        var directory = PosixDirName(path);
        var name = PosixBaseName(path);

        await using var exec = await DockerExec.StartAsync(
            _api, instance, ["tar", "-C", directory, "-cf", "-", name], tty: false, ct: ct).ConfigureAwait(false);

        await response.StartStreamAsync(200, "application/x-tar", ct).ConfigureAwait(false);

        var socket = exec.Sockets["1"];
        var buffer = new byte[64 * 1024];

        while (socket.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;

            try
            {
                result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
                break;
            }

            if (result.MessageType == WebSocketMessageType.Close || result.Count == 0)
            {
                break;
            }

            await response.WriteChunkAsync(buffer.AsMemory(0, result.Count), ct).ConfigureAwait(false);
        }

        await exec.WaitAsync(ct).ConfigureAwait(false);
        await response.EndStreamAsync(ct).ConfigureAwait(false);
    }

    private async Task ExtractTarInAsync(string instance, string path, ShimRequest request, ShimResponse response, CancellationToken ct)
    {
        await using var exec = await DockerExec.StartAsync(
            _api,
            instance,
            ["sh", "-c", $"mkdir -p {Workspace.Quote(path)} && tar -C {Workspace.Quote(path)} -xf -"],
            tty: false,
            ct: ct).ConfigureAwait(false);

        var stdin = exec.Stdin;
        var buffer = new byte[64 * 1024];
        int read;

        while ((read = await request.Body.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            await stdin.SendAsync(buffer.AsMemory(0, read), WebSocketMessageType.Binary, endOfMessage: true, ct).ConfigureAwait(false);
        }

        if (stdin.State == WebSocketState.Open)
        {
            await stdin.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, ct).ConfigureAwait(false);
        }

        var code = await exec.WaitAsync(ct).ConfigureAwait(false);

        if (code != 0)
        {
            await response.ErrorAsync(500, $"tar exited {code}", ct).ConfigureAwait(false);
            return;
        }

        await response.EmptyAsync(200, ct).ConfigureAwait(false);
    }

    // -- inspect / summary ---------------------------------------------------

    private async Task<object> InspectAsync(ShimContainer container, CancellationToken ct)
    {
        var state = await _api.StateAsync(container.Instance, ct).ConfigureAwait(false);
        var instance = await _api.InstanceAsync(container.Instance, ct).ConfigureAwait(false);
        var running = state is { IsRunning: true };
        var address = state?.Address ?? "";
        var mac = instance?.Config.GetValueOrDefault("volatile.eth0.hwaddr", "") ?? "";
        var gateway = _host.Cidr.Split('/')[0];

        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Id"] = container.Id,
            ["Created"] = container.Created.ToString("o", CultureInfo.InvariantCulture),
            ["Path"] = container.Entrypoint is { Count: > 0 } ep ? ep[0]
                : container.Cmd is { Count: > 0 } cm ? cm[0] : "/sbin/init",
            ["Args"] = container.Entrypoint is { Count: > 0 }
                ? container.Entrypoint.Skip(1).Concat(container.Cmd ?? []).ToArray()
                : (container.Cmd ?? []).Skip(1).ToArray(),
            ["State"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["Status"] = running ? "running" : "exited",
                ["Running"] = running,
                ["Paused"] = false,
                ["Restarting"] = false,
                ["OOMKilled"] = false,
                ["Dead"] = false,
                ["Pid"] = running ? 1 : 0,
                ["ExitCode"] = 0,
                ["Error"] = "",
                ["StartedAt"] = running ? container.Created.ToString("o", CultureInfo.InvariantCulture) : "0001-01-01T00:00:00Z",
                ["FinishedAt"] = "0001-01-01T00:00:00Z",
            },
            ["Image"] = "sha256:" + Sha256(container.Image),
            ["Name"] = "/" + container.Name,
            ["RestartCount"] = 0,
            ["Driver"] = "zfs",
            ["Platform"] = "linux",
            ["ExecIDs"] = Array.Empty<string>(),
            ["HostConfig"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["NetworkMode"] = "bridge",
                ["Binds"] = Array.Empty<string>(),
                ["Mounts"] = container.Mounts.Select(m => WireJson.Object(DockerJson.Options, ("Type", m.Type), ("Source", m.Source), ("Target", m.Destination))).ToArray(),
                ["RestartPolicy"] = WireJson.Object(DockerJson.Options, ("Name", "no"), ("MaximumRetryCount", 0)),
                ["Privileged"] = false,
                ["Runtime"] = "runc",
            },
            ["Mounts"] = container.Mounts.Select(m => new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["Type"] = m.Type,
                ["Source"] = m.Source,
                ["Destination"] = m.Destination,
                ["Mode"] = "",
                ["RW"] = m.ReadWrite,
                ["Propagation"] = "",
            }).ToArray(),
            ["Config"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["Hostname"] = container.Instance,
                ["User"] = container.User,
                ["Tty"] = false,
                ["Env"] = container.Env,
                ["Cmd"] = container.Cmd,
                ["Entrypoint"] = container.Entrypoint,
                ["Image"] = container.Image,
                ["WorkingDir"] = container.WorkingDir,
                ["Labels"] = container.Labels,
            },
            ["NetworkSettings"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["IPAddress"] = address,
                ["IPPrefixLen"] = _host.Range.PrefixLength,
                ["Gateway"] = gateway,
                ["MacAddress"] = mac,
                ["Ports"] = new Dictionary<string, object?>(StringComparer.Ordinal),
                ["Networks"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["bridge"] = WireJson.Object(DockerJson.Options, ("IPAddress", address), ("IPPrefixLen", _host.Range.PrefixLength), ("Gateway", gateway), ("MacAddress", mac), ("NetworkID", _host.Network)),
                },
            },
        };
    }

    private static Dictionary<string, object?> Summary(ShimContainer container, bool running) => new Dictionary<string, object?>(StringComparer.Ordinal)
    {
        ["Id"] = container.Id,
        ["Names"] = new[] { "/" + container.Name },
        ["Image"] = container.Image,
        ["ImageID"] = "sha256:" + Sha256(container.Image),
        ["Command"] = string.Join(' ', (container.Entrypoint ?? []).Concat(container.Cmd ?? [])),
        ["Created"] = container.Created.ToUnixTimeSeconds(),
        ["Ports"] = Array.Empty<object>(),
        ["Labels"] = container.Labels,
        ["State"] = running ? "running" : "exited",
        ["Status"] = running ? "Up" : "Exited (0)",
        ["HostConfig"] = WireJson.Object(DockerJson.Options, ("NetworkMode", "bridge")),
        ["Mounts"] = container.Mounts.Select(m => WireJson.Object(DockerJson.Options, ("Type", m.Type), ("Source", m.Source), ("Destination", m.Destination))).ToArray(),
    };

    // -- instance ↔ container -----------------------------------------------

    /// <summary>
    /// Every instance the shim can present as a container, with whether it is up.
    /// </summary>
    /// <remarks>
    /// Its own, plus every other envmux instance — which is what lets the
    /// <c>attached-container+…</c> form reach a session already running (§8.3).
    /// The running bit is taken from the instance the enumeration already
    /// carries, so the list costs one call rather than one per container.
    /// </remarks>
    private async Task<IReadOnlyList<(ShimContainer Container, bool Running)>> ContainersAsync(CancellationToken ct)
    {
        var instances = await _api.InstancesAsync(ct).ConfigureAwait(false);
        var containers = new List<(ShimContainer, bool)>();

        foreach (var instance in instances)
        {
            if (_state.ByInstance(instance.Name) is { } known)
            {
                containers.Add((known, instance.IsRunning));
            }
            else if (InstanceSpec.IsOurs(instance))
            {
                containers.Add((FromInstance(instance), instance.IsRunning));
            }
        }

        return containers;
    }

    private static ShimContainer FromInstance(Instance instance)
    {
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (key, value) in instance.Config)
        {
            if (key.StartsWith("user.", StringComparison.Ordinal))
            {
                labels[key["user.".Length..]] = value;
            }
        }

        return new ShimContainer
        {
            Id = Sha256(instance.Name),
            Name = instance.Name,
            Instance = instance.Name,
            Created = DateTimeOffset.UtcNow,
            Labels = labels,
            Image = instance.Config.GetValueOrDefault("image.description", "envmux"),
            Env = [],
        };
    }

    private async Task<ShimContainer?> ResolveAsync(string reference, CancellationToken ct)
    {
        var containers = (await ContainersAsync(ct).ConfigureAwait(false)).Select(c => c.Container).ToList();

        return containers.FirstOrDefault(c => c.Id == reference || c.Name == reference || c.Instance == reference)
            ?? containers.FirstOrDefault(c => reference.Length >= 4 && c.Id.StartsWith(reference, StringComparison.Ordinal));
    }

    // -- helpers -------------------------------------------------------------

    private static string First(string path)
    {
        var trimmed = path.TrimStart('/');
        var slash = trimmed.IndexOf('/', StringComparison.Ordinal);
        return slash < 0 ? trimmed : trimmed[..slash];
    }

    private static string Sha256(string input) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(input)));

    private static string RandomHex(int bytes) => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(bytes));

    private static string PosixDirName(string path)
    {
        var trimmed = path.TrimEnd('/');
        var slash = trimmed.LastIndexOf('/');
        return slash <= 0 ? "/" : trimmed[..slash];
    }

    private static string PosixBaseName(string path)
    {
        var trimmed = path.TrimEnd('/');
        var slash = trimmed.LastIndexOf('/');
        return slash < 0 ? trimmed : trimmed[(slash + 1)..];
    }

    private static async Task WriteJsonLineAsync(ShimResponse response, object value, CancellationToken ct)
    {
        try
        {
            var bytes = WireJson.SerializeToUtf8Bytes(value, DockerJson.Options);
            var line = new byte[bytes.Length + 1];
            bytes.CopyTo(line, 0);
            line[^1] = (byte)'\n';
            await response.WriteChunkAsync(line, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
            // A listener that has gone.
        }
    }
}
