using System.Collections.Concurrent;
using System.Formats.Tar;
using System.Globalization;
using System.Text;

using Envmux.Backends.DockerEngine;
using Envmux.Docker;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// A Docker engine that is a handful of dictionaries, for everything that codes
/// against <see cref="IDockerEngine"/>.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written, because this repository has no mocking library and does not
/// want one: a fake that behaves like an engine — names are unique, a network
/// with running containers will not go, a volume a container mounts will not
/// go — finds the bugs a recorded expectation cannot. It refuses the things the
/// real engine refuses, with a <see cref="DockerEngineException"/> carrying the
/// status the real engine gives, and is no cleverer than that.
/// </para>
/// <para>
/// One lock guards everything, so each operation is atomic exactly as each
/// engine call is, and a race between two callers is a real race with one
/// winner. <see cref="Intercept"/> runs before every operation, outside the
/// lock: a test awaits in it to widen a window, or throws from it to be the
/// engine failing. <see cref="Calls"/> is what was asked, in order.
/// </para>
/// <para>
/// What it does not pretend: there are no processes (an exec's output is
/// whatever <see cref="OnExec"/> says), no layers (an image is a name and its
/// labels), and no network (addresses are handed out and mean nothing).
/// </para>
/// </remarks>
internal sealed class FakeDockerEngine : IDockerEngine
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, FakeContainer> _containers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, NetworkSummary> _networks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, VolumeSummary> _volumes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ImageInspect> _images = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FakeExec> _execs = new(StringComparer.Ordinal);
    private int _serial;

    public string Endpoint { get; init; } = "fake://docker";

    /// <summary>
    /// Awaited before every operation with its name (<c>CreateNetwork</c>) and
    /// what it is about (the network's name). Throw from it to fail the call.
    /// </summary>
    public Func<string, string, Task>? Intercept { get; set; }

    /// <summary>Every operation asked for, in the order it was asked.</summary>
    public ConcurrentQueue<(string Operation, string Subject)> Calls { get; } = new();

    /// <summary>Every container asked for, with what it was asked for as — kept after the container is gone.</summary>
    public ConcurrentQueue<(string Name, ContainerCreate Create)> Created { get; } = new();

    /// <summary>
    /// What an exec does: handed the exec, it says what was written and what it
    /// exited with. Without one every command succeeds in silence.
    /// </summary>
    public Func<FakeExec, FakeExecResult>? OnExec { get; set; }

    /// <summary>
    /// For a test that needs the connection itself — a terminal that stays
    /// open, output that arrives in pieces. When this returns a stream it is
    /// what <see cref="ExecStartAsync"/> hands back, and the exec stays
    /// running until <see cref="FakeExec.Exit"/> is called.
    /// </summary>
    public Func<FakeExec, Stream?>? OnExecStream { get; set; }

    /// <summary>Whether creating a container from an image nobody pulled or built is refused, as it really is.</summary>
    public bool ImagesMustExist { get; set; } = true;

    public bool Disposed { get; private set; }

    /// <summary>How many times an operation was asked for.</summary>
    public int Count(string operation) =>
        Calls.Count(c => string.Equals(c.Operation, operation, StringComparison.Ordinal));

    // What a test puts there beforehand, and looks at afterwards.

    /// <summary>A network that was there already — somebody else's, if it has no labels.</summary>
    public void AddNetwork(string name, IReadOnlyDictionary<string, string>? labels = null)
    {
        lock (_gate)
        {
            _networks[name] = new NetworkSummary(NextId(), name, Copy(labels));
        }
    }

    public void AddImage(string reference, IReadOnlyDictionary<string, string>? labels = null)
    {
        lock (_gate)
        {
            _images[reference] = new ImageInspect("sha256:" + NextId(), [reference], Copy(labels));
        }
    }

    public void AddVolume(string name, IReadOnlyDictionary<string, string>? labels = null)
    {
        lock (_gate)
        {
            _volumes[name] = new VolumeSummary(name, Copy(labels));
        }
    }

    /// <summary>Put a file in a container without a tar.</summary>
    public void AddFile(string container, string path, string content, int mode = 0b110_100_100)
    {
        lock (_gate)
        {
            Need(container).Files[Normal(path)] = new FakeFile(Encoding.UTF8.GetBytes(content), mode);
        }
    }

    /// <summary>A file in a container, as <see cref="PutArchiveAsync"/> or <see cref="AddFile"/> left it.</summary>
    public FakeFile? FileIn(string container, string path)
    {
        lock (_gate)
        {
            return Need(container).Files.GetValueOrDefault(Normal(path));
        }
    }

    /// <summary>A container, by name or id, or null.</summary>
    public FakeContainer? Container(string nameOrId)
    {
        lock (_gate)
        {
            return Find(nameOrId);
        }
    }

    public IReadOnlyList<FakeContainer> AllContainers
    {
        get
        {
            lock (_gate)
            {
                return [.. _containers.Values];
            }
        }
    }

    public IReadOnlyList<FakeExec> AllExecs
    {
        get
        {
            lock (_gate)
            {
                return [.. _execs.Values];
            }
        }
    }

    public IReadOnlyList<string> NetworkNames
    {
        get
        {
            lock (_gate)
            {
                return [.. _networks.Keys.Order(StringComparer.Ordinal)];
            }
        }
    }

    public IReadOnlyList<string> VolumeNames
    {
        get
        {
            lock (_gate)
            {
                return [.. _volumes.Keys.Order(StringComparer.Ordinal)];
            }
        }
    }

    public IReadOnlyList<string> ImageNames
    {
        get
        {
            lock (_gate)
            {
                return [.. _images.Keys.Order(StringComparer.Ordinal)];
            }
        }
    }

    /// <summary>Every build asked for: the tag, the labels, and the tar it was given.</summary>
    public ConcurrentQueue<(string Tag, IReadOnlyDictionary<string, string> Labels, byte[] Context)> Builds { get; } = new();

    // The engine.

    public async Task<EngineVersion> VersionAsync(CancellationToken ct = default)
    {
        await Enter("Version", "", ct);
        return new EngineVersion("0.0.0-fake", "1.51", "linux", "amd64", "Fake Engine");
    }

    public async Task<IReadOnlyList<ContainerSummary>> ContainersAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        bool all = true,
        CancellationToken ct = default)
    {
        await Enter("Containers", Describe(labels), ct);

        lock (_gate)
        {
            return
            [
                .. _containers.Values
                    .Where(c => (all || c.Running) && Matches(c.Create.Labels, labels))
                    .Select(c => new ContainerSummary(c.Id, ["/" + c.Name], c.Create.Image, c.Status, c.Create.Labels)),
            ];
        }
    }

    public async Task<ContainerInspect?> InspectAsync(string container, CancellationToken ct = default)
    {
        await Enter("Inspect", container, ct);

        lock (_gate)
        {
            return Find(container) is { } c
                ? new ContainerInspect(
                    c.Id,
                    "/" + c.Name,
                    c.Create.Image,
                    c.Status,
                    c.Running,
                    c.ExitCode,
                    c.Create.Labels,
                    c.Create.Ports,
                    c.Create.Mounts,
                    c.Running && c.Create.Network is { } network
                        ? new Dictionary<string, string>(StringComparer.Ordinal) { [network] = c.Address }
                        : new Dictionary<string, string>(StringComparer.Ordinal))
                : null;
        }
    }

    public async Task<string> CreateContainerAsync(string name, ContainerCreate body, CancellationToken ct = default)
    {
        await Enter("CreateContainer", name, ct);

        lock (_gate)
        {
            if (_containers.Values.Any(c => string.Equals(c.Name, name, StringComparison.Ordinal)))
            {
                throw Refuse(409, $"Conflict. The container name \"/{name}\" is already in use");
            }

            if (ImagesMustExist && !_images.ContainsKey(body.Image) &&
                !_images.Values.Any(image => string.Equals(image.Id, body.Image, StringComparison.Ordinal)))
            {
                throw Refuse(404, $"No such image: {body.Image}");
            }

            if (body.Network is { } network && !_networks.ContainsKey(network))
            {
                throw Refuse(404, $"network {network} not found");
            }

            var serial = ++_serial;
            var container = new FakeContainer(NextId(), name, body)
            {
                Address = $"172.18.{(serial >> 8) & 0xff}.{serial & 0xff}",
            };

            // A named volume that does not exist is made by the create, which
            // is what the real engine does — unlabelled, which is the catch.
            foreach (var mount in body.Mounts.Where(m => string.Equals(m.Type, "volume", StringComparison.Ordinal)))
            {
                _volumes.TryAdd(mount.Source, new VolumeSummary(mount.Source, Copy(null)));
            }

            _containers[container.Id] = container;
            Created.Enqueue((name, body));
            return container.Id;
        }
    }

    public async Task StartAsync(string container, CancellationToken ct = default)
    {
        await Enter("Start", container, ct);

        lock (_gate)
        {
            var c = Need(container);
            if (c.Running)
            {
                return;
            }

            foreach (var port in c.Create.Ports)
            {
                var holder = _containers.Values.FirstOrDefault(other =>
                    other.Running && other.Create.Ports.Any(p =>
                        p.HostPort == port.HostPort &&
                        string.Equals(p.Protocol, port.Protocol, StringComparison.Ordinal) &&
                        Overlaps(p.HostIp, port.HostIp)));

                if (holder is not null)
                {
                    throw Refuse(
                        500,
                        $"driver failed programming external connectivity on endpoint {c.Name}: " +
                        $"Bind for {port.HostIp}:{port.HostPort.ToString(CultureInfo.InvariantCulture)} failed: port is already allocated");
                }
            }

            c.Running = true;
            c.ExitCode = null;
            c.Started++;
        }
    }

    public async Task StopAsync(string container, int timeoutSeconds = 10, CancellationToken ct = default)
    {
        await Enter("Stop", container, ct);

        lock (_gate)
        {
            var c = Need(container);
            if (c.Running)
            {
                c.Running = false;
                c.ExitCode = 137;
            }
        }
    }

    public async Task<bool> RemoveAsync(
        string container,
        bool force = true,
        bool volumes = false,
        CancellationToken ct = default)
    {
        await Enter("Remove", container, ct);

        lock (_gate)
        {
            if (Find(container) is not { } c)
            {
                return false;
            }

            if (c.Running && !force)
            {
                throw Refuse(409, $"cannot remove container \"/{c.Name}\": container is running: stop the container before removing or force remove");
            }

            // The real flag removes anonymous volumes only; a named one stays,
            // and the fake has no anonymous ones to remove.
            _containers.Remove(c.Id);
            return true;
        }
    }

    /// <summary>There are no processes here, so a container that is running has nothing to wait on: a test stops it first.</summary>
    public async Task<int> WaitAsync(string container, CancellationToken ct = default)
    {
        await Enter("Wait", container, ct);

        lock (_gate)
        {
            var c = Need(container);

            return c.Running
                ? throw new NotSupportedException("the fake engine has no processes: stop the container before waiting on it")
                : c.ExitCode ?? 0;
        }
    }

    public async Task<string> CommitAsync(string container, string repository, string tag, CancellationToken ct = default)
    {
        await Enter("Commit", container, ct);

        lock (_gate)
        {
            var c = Need(container);
            var reference = $"{repository}:{tag}";
            var image = new ImageInspect("sha256:" + NextId(), [reference], Copy(c.Create.Labels));
            _images[reference] = image;
            return image.Id;
        }
    }

    public async Task<string> ExecCreateAsync(string container, ExecCreate body, CancellationToken ct = default)
    {
        await Enter("ExecCreate", container, ct);

        lock (_gate)
        {
            var c = Need(container);
            if (!c.Running)
            {
                throw Refuse(409, $"container {c.Id} is not running");
            }

            var exec = new FakeExec(NextId(), c.Name, body);
            _execs[exec.Id] = exec;
            return exec.Id;
        }
    }

    public async Task<Stream> ExecStartAsync(string execId, bool tty, CancellationToken ct = default)
    {
        await Enter("ExecStart", execId, ct);

        FakeExec exec;
        lock (_gate)
        {
            exec = _execs.GetValueOrDefault(execId) ?? throw Refuse(404, $"No such exec instance: {execId}");
            exec.Running = true;
            exec.Pid = 1000 + ++_serial;
        }

        if (OnExecStream?.Invoke(exec) is { } custom)
        {
            return custom;
        }

        var result = OnExec?.Invoke(exec) ?? new FakeExecResult(0);
        var output = new MemoryStream();

        if (tty)
        {
            // A terminal has one stream: what would have been stderr is drawn
            // with everything else.
            output.Write(Encoding.UTF8.GetBytes(result.Stdout + result.Stderr));
        }
        else
        {
            if (result.Stdout.Length > 0)
            {
                output.Write(StdCopy.Frame(StdCopy.Stdout, Encoding.UTF8.GetBytes(result.Stdout)));
            }

            if (result.Stderr.Length > 0)
            {
                output.Write(StdCopy.Frame(StdCopy.Stderr, Encoding.UTF8.GetBytes(result.Stderr)));
            }
        }

        exec.Exit(result.ExitCode);
        return new FakeHijackedStream(output.ToArray(), exec);
    }

    public async Task ExecResizeAsync(string execId, int columns, int rows, CancellationToken ct = default)
    {
        await Enter("ExecResize", execId, ct);

        lock (_gate)
        {
            var exec = _execs.GetValueOrDefault(execId) ?? throw Refuse(404, $"No such exec instance: {execId}");
            exec.Resizes.Add((columns, rows));
        }
    }

    public async Task<ExecInspect> ExecInspectAsync(string execId, CancellationToken ct = default)
    {
        await Enter("ExecInspect", execId, ct);

        lock (_gate)
        {
            var exec = _execs.GetValueOrDefault(execId) ?? throw Refuse(404, $"No such exec instance: {execId}");
            return new ExecInspect(exec.Running, exec.ExitCode, exec.Pid);
        }
    }

    public async Task PutArchiveAsync(string container, string directory, Stream tar, CancellationToken ct = default)
    {
        await Enter("PutArchive", container, ct);

        // Read outside the lock: the stream is the caller's and may be slow.
        var files = new List<(string Path, FakeFile File)>();
        using (var reader = new TarReader(tar, leaveOpen: true))
        {
            while (await reader.GetNextEntryAsync(copyData: false, ct) is { } entry)
            {
                if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) ||
                    entry.DataStream is null)
                {
                    continue;
                }

                using var content = new MemoryStream();
                await entry.DataStream.CopyToAsync(content, ct);
                files.Add((Normal(directory + "/" + entry.Name), new FakeFile(content.ToArray(), (int)entry.Mode)));
            }
        }

        lock (_gate)
        {
            var c = Need(container);
            foreach (var (path, file) in files)
            {
                c.Files[path] = file;
            }
        }
    }

    public async Task<Stream?> GetArchiveAsync(string container, string path, CancellationToken ct = default)
    {
        await Enter("GetArchive", container, ct);

        List<(string Name, FakeFile File)> entries;
        lock (_gate)
        {
            var c = Need(container);
            var wanted = Normal(path);

            // As the engine does it: a file comes back under its own name, a
            // directory's contents under the directory's.
            var parent = wanted[..(wanted.LastIndexOf('/') + 1)];
            entries =
            [
                .. c.Files
                    .Where(f => string.Equals(f.Key, wanted, StringComparison.Ordinal) ||
                                f.Key.StartsWith(wanted + "/", StringComparison.Ordinal))
                    .OrderBy(f => f.Key, StringComparer.Ordinal)
                    .Select(f => (f.Key[parent.Length..], f.Value)),
            ];
        }

        if (entries.Count == 0)
        {
            return null;
        }

        var tar = new MemoryStream();
        await using (var writer = new TarWriter(tar, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var (name, file) in entries)
            {
                await writer.WriteEntryAsync(
                    new PaxTarEntry(TarEntryType.RegularFile, name)
                    {
                        Mode = (UnixFileMode)file.Mode,
                        DataStream = new MemoryStream(file.Content),
                    },
                    ct);
            }
        }

        tar.Position = 0;
        return tar;
    }

    public async Task<IReadOnlyList<NetworkSummary>> NetworksAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        await Enter("Networks", Describe(labels), ct);

        lock (_gate)
        {
            return [.. _networks.Values.Where(n => Matches(n.Labels, labels))];
        }
    }

    public Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default) =>
        CreateNetworkAsync(name, labels, subnet: null, gateway: null, ct);

    /// <summary>The subnet is taken and not checked: the fake has no address space for it to overlap.</summary>
    public async Task<bool> CreateNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        string? subnet,
        string? gateway = null,
        CancellationToken ct = default)
    {
        await Enter("CreateNetwork", name, ct);

        // Look and take under the same lock, as the engine's name index is.
        lock (_gate)
        {
            return _networks.TryAdd(name, new NetworkSummary(NextId(), name, Copy(labels)));
        }
    }

    public async Task<bool> RemoveNetworkAsync(string name, CancellationToken ct = default)
    {
        await Enter("RemoveNetwork", name, ct);

        lock (_gate)
        {
            if (!_networks.ContainsKey(name))
            {
                return false;
            }

            // A stopped container does not hold a network; a running one does.
            if (_containers.Values.Any(c => c.Running && string.Equals(c.Create.Network, name, StringComparison.Ordinal)))
            {
                throw Refuse(403, $"error while removing network: network {name} has active endpoints");
            }

            return _networks.Remove(name);
        }
    }

    public async Task<IReadOnlyList<VolumeSummary>> VolumesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        await Enter("Volumes", Describe(labels), ct);

        lock (_gate)
        {
            return [.. _volumes.Values.Where(v => Matches(v.Labels, labels))];
        }
    }

    public async Task CreateVolumeAsync(
        string name,
        IReadOnlyDictionary<string, string> labels,
        CancellationToken ct = default)
    {
        await Enter("CreateVolume", name, ct);

        lock (_gate)
        {
            // Creating one that exists is not an error, and does not relabel it.
            _volumes.TryAdd(name, new VolumeSummary(name, Copy(labels)));
        }
    }

    public async Task<bool> RemoveVolumeAsync(string name, CancellationToken ct = default)
    {
        await Enter("RemoveVolume", name, ct);

        lock (_gate)
        {
            if (!_volumes.ContainsKey(name))
            {
                return false;
            }

            // Unlike a network, a volume is held by a container that merely exists.
            if (_containers.Values.Any(c => c.Create.Mounts.Any(m =>
                    string.Equals(m.Type, "volume", StringComparison.Ordinal) &&
                    string.Equals(m.Source, name, StringComparison.Ordinal))))
            {
                throw Refuse(409, $"remove {name}: volume is in use");
            }

            return _volumes.Remove(name);
        }
    }

    public async Task<ImageInspect?> ImageAsync(string reference, CancellationToken ct = default)
    {
        await Enter("Image", reference, ct);

        lock (_gate)
        {
            return _images.GetValueOrDefault(reference) ??
                   _images.Values.FirstOrDefault(i => string.Equals(i.Id, reference, StringComparison.Ordinal));
        }
    }

    public async Task<IReadOnlyList<ImageInspect>> ImagesAsync(
        IReadOnlyDictionary<string, string>? labels = null,
        CancellationToken ct = default)
    {
        await Enter("Images", Describe(labels), ct);

        lock (_gate)
        {
            return [.. _images.Values.Where(i => Matches(i.Labels, labels))];
        }
    }

    public async Task PullAsync(string reference, Action<string>? report = null, CancellationToken ct = default)
    {
        await Enter("Pull", reference, ct);

        report?.Invoke($"Pulling from {reference}");

        lock (_gate)
        {
            _images.TryAdd(reference, new ImageInspect("sha256:" + NextId(), [reference], Copy(null)));
        }

        report?.Invoke($"Status: Downloaded newer image for {reference}");
    }

    public async Task BuildAsync(
        Stream tarContext,
        string tag,
        IReadOnlyDictionary<string, string>? labels = null,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        await Enter("Build", tag, ct);

        using var context = new MemoryStream();
        await tarContext.CopyToAsync(context, ct);
        Builds.Enqueue((tag, Copy(labels), context.ToArray()));

        report?.Invoke("Step 1/1 : FROM scratch");

        lock (_gate)
        {
            _images[tag] = new ImageInspect("sha256:" + NextId(), [tag], Copy(labels));
        }

        report?.Invoke($"Successfully tagged {tag}");
    }

    public async Task<bool> RemoveImageAsync(string reference, CancellationToken ct = default)
    {
        await Enter("RemoveImage", reference, ct);

        lock (_gate)
        {
            return _images.Remove(reference);
        }
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }

    private async Task Enter(string operation, string subject, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(Disposed, this);

        Calls.Enqueue((operation, subject));

        if (Intercept is { } intercept)
        {
            await intercept(operation, subject);
        }
    }

    private FakeContainer? Find(string nameOrId) =>
        _containers.GetValueOrDefault(nameOrId) ??
        _containers.Values.FirstOrDefault(c =>
            string.Equals(c.Name, nameOrId.TrimStart('/'), StringComparison.Ordinal) ||
            (nameOrId.Length >= 12 && c.Id.StartsWith(nameOrId, StringComparison.Ordinal)));

    private FakeContainer Need(string nameOrId) =>
        Find(nameOrId) ?? throw Refuse(404, $"No such container: {nameOrId}");

    private string NextId()
    {
        // Sixty-four hex characters, like the real thing, and the same ones every run.
        var serial = Interlocked.Increment(ref _serial);
        return serial.ToString("x8", CultureInfo.InvariantCulture).PadRight(64, 'f');
    }

    private static DockerEngineException Refuse(int status, string message) => new(message) { Status = status };

    /// <summary>Every label wanted is there; an empty value, as in the engine's own filter, means "present".</summary>
    private static bool Matches(IReadOnlyDictionary<string, string> has, IReadOnlyDictionary<string, string>? wanted) =>
        wanted is null ||
        wanted.All(w => has.TryGetValue(w.Key, out var value) &&
                        (w.Value.Length == 0 || string.Equals(value, w.Value, StringComparison.Ordinal)));

    /// <summary>Two publishes fight when they are the same address, or either is every address.</summary>
    private static bool Overlaps(string a, string b) =>
        string.Equals(a, b, StringComparison.Ordinal) || a is "" or "0.0.0.0" || b is "" or "0.0.0.0";

    private static Dictionary<string, string> Copy(IReadOnlyDictionary<string, string>? labels) =>
        labels is null
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : new Dictionary<string, string>(labels, StringComparer.Ordinal);

    private static string Describe(IReadOnlyDictionary<string, string>? labels) =>
        labels is null
            ? ""
            : string.Join(",", labels.OrderBy(l => l.Key, StringComparer.Ordinal).Select(l => $"{l.Key}={l.Value}"));

    private static string Normal(string path)
    {
        var parts = path.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Where(p => !string.Equals(p, ".", StringComparison.Ordinal));
        return "/" + string.Join('/', parts);
    }
}

/// <summary>A file in a fake container: what is in it, and its permission bits.</summary>
internal sealed record FakeFile(byte[] Content, int Mode)
{
    public string Text => Encoding.UTF8.GetString(Content);
}

/// <summary>A container the fake engine holds: what it was created from, and whether it is up.</summary>
internal sealed class FakeContainer(string id, string name, ContainerCreate create)
{
    public string Id { get; } = id;

    public string Name { get; } = name;

    public ContainerCreate Create { get; } = create;

    public bool Running { get; set; }

    public int? ExitCode { get; set; }

    /// <summary>How many times it has been started.</summary>
    public int Started { get; set; }

    /// <summary>Its address on its network, which means nothing and is stable.</summary>
    public string Address { get; init; } = "";

    public Dictionary<string, FakeFile> Files { get; } = new(StringComparer.Ordinal);

    public string Status => Running ? "running" : Started > 0 ? "exited" : "created";
}

/// <summary>What <see cref="FakeDockerEngine.OnExec"/> answers: the exit code and what was written.</summary>
internal sealed record FakeExecResult(int ExitCode, string Stdout = "", string Stderr = "");

/// <summary>An exec the fake engine was asked for.</summary>
internal sealed class FakeExec(string id, string container, ExecCreate create)
{
    private readonly List<byte> _stdin = [];

    public string Id { get; } = id;

    /// <summary>The container's name.</summary>
    public string Container { get; } = container;

    public ExecCreate Create { get; } = create;

    public bool Running { get; set; }

    public int? ExitCode { get; private set; }

    public int Pid { get; set; }

    public List<(int Columns, int Rows)> Resizes { get; } = [];

    /// <summary>Everything written down the connection so far.</summary>
    public byte[] Stdin
    {
        get
        {
            lock (_stdin)
            {
                return [.. _stdin];
            }
        }
    }

    /// <summary>Whether the writer said it was finished, through <see cref="IHalfClose"/>.</summary>
    public bool StdinEnded { get; set; }

    /// <summary>The command as one line, for a test that matches on it.</summary>
    public string CommandLine => string.Join(' ', Create.Cmd);

    public void Exit(int code)
    {
        Running = false;
        ExitCode = code;
    }

    internal void Wrote(ReadOnlySpan<byte> bytes)
    {
        lock (_stdin)
        {
            _stdin.AddRange(bytes);
        }
    }
}

/// <summary>
/// The hijacked connection: what the exec wrote comes out, then end of stream;
/// what is written in is kept on the exec as its stdin.
/// </summary>
internal sealed class FakeHijackedStream(byte[] output, FakeExec exec) : Stream, IHalfClose
{
    private readonly MemoryStream _output = new(output, writable: false);

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => true;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => _output.Read(buffer, offset, count);

    public override int Read(Span<byte> buffer) => _output.Read(buffer);

    public override void Write(byte[] buffer, int offset, int count) => exec.Wrote(buffer.AsSpan(offset, count));

    public override void Write(ReadOnlySpan<byte> buffer) => exec.Wrote(buffer);

    /// <summary>Stdin has ended; the output is still there to be read.</summary>
    public ValueTask CompleteWriteAsync(CancellationToken ct = default)
    {
        exec.StdinEnded = true;
        return ValueTask.CompletedTask;
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();
}
