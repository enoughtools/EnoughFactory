using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

using Envmux.Docker;
using Envmux.Editor;

namespace Envmux.Tests;

/// <summary>
/// The host-free half of the Docker shim: the framing, the filter grammar, the
/// URI, and the hand-written HTTP that serves the docker CLI. The Incus side is
/// exercised against a host in spikes/vscode-remote and by the acceptance
/// matrix; what is here is everything that does not need one.
/// </summary>
public class DockerShimTests
{
    // -- stdcopy framing -----------------------------------------------------

    [Fact]
    public void FrameCarriesStreamAndBigEndianLength()
    {
        var frame = StdCopy.Frame(StdCopy.Stderr, "hello"u8);

        Assert.Equal(StdCopy.Stderr, frame[0]);
        Assert.Equal(0, frame[1]);
        Assert.Equal(0, frame[2]);
        Assert.Equal(0, frame[3]);
        Assert.Equal(5u, BinaryPrimitives.ReadUInt32BigEndian(frame.AsSpan(4, 4)));
        Assert.Equal("hello", Encoding.UTF8.GetString(frame.AsSpan(8)));
    }

    [Fact]
    public void FrameOfEmptyPayloadIsHeaderOnly()
    {
        Assert.Equal(StdCopy.HeaderLength, StdCopy.Frame(StdCopy.Stdout, []).Length);
    }

    // -- filters -------------------------------------------------------------

    [Fact]
    public void ParsesBothFilterShapes()
    {
        var asObject = DockerFilters.Parse("""{"label":{"a=b":true,"c":true}}""");
        Assert.Equal(["a=b", "c"], asObject["label"]);

        var asArray = DockerFilters.Parse("""{"label":["a=b"]}""");
        Assert.Equal(["a=b"], asArray["label"]);
    }

    [Fact]
    public void LabelFilterMatchesKeyAndValue()
    {
        var container = Container(("devcontainer.local_folder", @"C:\Users\Matt\demo"));

        Assert.True(DockerFilters.Matches(
            DockerFilters.Parse("""{"label":{"devcontainer.local_folder=C:\\Users\\Matt\\demo":true}}"""),
            container,
            running: true));

        // The wrong value does not match — a reattach must not find the wrong instance.
        Assert.False(DockerFilters.Matches(
            DockerFilters.Parse("""{"label":{"devcontainer.local_folder=C:\\Users\\Matt\\other":true}}"""),
            container,
            running: true));

        // Bare key: present is enough.
        Assert.True(DockerFilters.Matches(
            DockerFilters.Parse("""{"label":{"devcontainer.local_folder":true}}"""),
            container,
            running: true));
    }

    [Fact]
    public void StatusFilterSeparatesRunningFromExited()
    {
        var container = Container();
        var running = DockerFilters.Parse("""{"status":["running"]}""");

        Assert.True(DockerFilters.Matches(running, container, running: true));
        Assert.False(DockerFilters.Matches(running, container, running: false));
    }

    // -- dev-container URI (§8.1) --------------------------------------------

    [Fact]
    public void DevContainerUriDecodesToTheAuthorityTheExtensionExpects()
    {
        var uri = DockerUri.DevContainerFolderUri(
            @"C:\Users\Matt\demo",
            @"C:\Users\Matt\demo\.devcontainer\devcontainer.json",
            workspaceFolder: null);

        Assert.StartsWith("vscode-remote://dev-container+", uri, StringComparison.Ordinal);

        var hex = uri["vscode-remote://dev-container+".Length..];
        var slash = hex.IndexOf('/', StringComparison.Ordinal);
        var authority = Convert.FromHexString(hex[..slash]);

        using var document = JsonDocument.Parse(authority);
        var root = document.RootElement;

        // localDocker:false is the whole point — it tells the extension the daemon is remote.
        Assert.False(root.GetProperty("localDocker").GetBoolean());
        Assert.Equal(@"C:\Users\Matt\demo", root.GetProperty("hostPath").GetString());

        // The drive is lowercased on fsPath, and the path form is forward-slashed with a leading slash.
        var configFile = root.GetProperty("configFile");
        Assert.Equal(1, configFile.GetProperty("$mid").GetInt32());
        Assert.Equal(@"c:\Users\Matt\demo\.devcontainer\devcontainer.json", configFile.GetProperty("fsPath").GetString());
        Assert.Equal("/c:/Users/Matt/demo/.devcontainer/devcontainer.json", configFile.GetProperty("path").GetString());
        Assert.Equal("file", configFile.GetProperty("scheme").GetString());

        // The default folder inside the target is /workspaces/<name>.
        Assert.Equal("/workspaces/demo", hex[slash..]);
    }

    [Fact]
    public void DevContainerUriHonoursWorkspaceFolderOverride()
    {
        var uri = DockerUri.DevContainerFolderUri(
            @"C:\Users\Matt\demo",
            @"C:\Users\Matt\demo\.devcontainer\devcontainer.json",
            workspaceFolder: "/src/app");

        Assert.EndsWith("/src/app", uri, StringComparison.Ordinal);
    }

    [Fact]
    public void AttachedContainerUriNamesTheInstanceAndOpensTheFolder()
    {
        // This is what attaches to any running instance as if it were a dev
        // container — no devcontainer.json, nothing built.
        var uri = DockerUri.AttachedContainerUri("myproj-feat-login", "/home/matt/project");

        Assert.StartsWith("vscode-remote://attached-container+", uri, StringComparison.Ordinal);

        var hex = uri["vscode-remote://attached-container+".Length..];
        var slash = hex.IndexOf('/', StringComparison.Ordinal);
        using var document = JsonDocument.Parse(Convert.FromHexString(hex[..slash]));

        Assert.Equal("myproj-feat-login", document.RootElement.GetProperty("containerName").GetString());
        Assert.Equal(JsonValueKind.Object, document.RootElement.GetProperty("settings").ValueKind);
        Assert.Equal("/home/matt/project", hex[slash..]);
    }

    [Fact]
    public void AttachedContainerUriCarriesTheDockerHostSoNoSettingsAreNeeded()
    {
        // settings.host is what the extension turns into DOCKER_HOST — including
        // for the "is Docker running" preflight — so the attach needs nothing in
        // the user's settings.json.
        var uri = DockerUri.AttachedContainerUri(
            "myproj-feat-login", "/home/matt/project", "npipe:////./pipe/envmux-docker");

        var hex = uri["vscode-remote://attached-container+".Length..];
        var slash = hex.IndexOf('/', StringComparison.Ordinal);
        using var document = JsonDocument.Parse(Convert.FromHexString(hex[..slash]));

        Assert.Equal(
            "npipe:////./pipe/envmux-docker",
            document.RootElement.GetProperty("settings").GetProperty("host").GetString());
    }

    // -- HTTP ----------------------------------------------------------------

    [Fact]
    public async Task StripsTheApiVersionPrefixAndParsesTheQuery()
    {
        var seen = new List<ShimRequest>();

        await ServeAsync(
            "GET /v1.47/containers/json?all=1&filters=%7B%7D HTTP/1.1\r\nHost: docker\r\n\r\n",
            async (request, response) =>
            {
                seen.Add(request);
                await response.JsonAsync(Array.Empty<object>(), CancellationToken.None);
            });

        var request = Assert.Single(seen);
        Assert.Equal("/containers/json", request.Path);
        Assert.Equal("1", request["all"]);
        Assert.Equal("{}", request["filters"]);
    }

    [Fact]
    public async Task ServesTwoRequestsOnOneKeptAliveConnection()
    {
        var count = 0;

        var response = await ServeAsync(
            "GET /_ping HTTP/1.1\r\n\r\nGET /_ping HTTP/1.1\r\n\r\n",
            async (_, r) =>
            {
                count++;
                await r.BytesAsync("OK"u8.ToArray(), 200, "text/plain", CancellationToken.None);
            });

        Assert.Equal(2, count);
        Assert.Equal(2, CountOccurrences(response, "HTTP/1.1 200"));
    }

    [Fact]
    public async Task ReadsAJsonBodyBoundedByContentLength()
    {
        const string body = """{"Name":"vscode"}""";
        VolumeCreateRequest? parsed = null;

        await ServeAsync(
            $"POST /volumes/create HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\n\r\n{body}",
            async (request, response) =>
            {
                parsed = await request.JsonAsync<VolumeCreateRequest>(CancellationToken.None);
                await response.JsonAsync(Envmux.Serialization.WireJson.Object(DockerJson.Options, ("Name", parsed!.Name)), 201, CancellationToken.None);
            });

        Assert.Equal("vscode", parsed?.Name);
    }

    [Fact]
    public async Task HijackReadsTheBodyThenTakesTheConnection()
    {
        const string body = """{"Detach":false,"Tty":false}""";
        var upgraded = false;
        var sawBody = false;

        var response = await ServeAsync(
            $"POST /exec/abc/start HTTP/1.1\r\nUpgrade: tcp\r\nConnection: Upgrade\r\nContent-Length: {body.Length}\r\n\r\n{body}",
            async (request, r) =>
            {
                Assert.True(request.WantsUpgrade);
                var start = await request.JsonAsync<ExecStartRequest>(CancellationToken.None);
                sawBody = start is not null;

                var io = await r.HijackAsync(tty: false, CancellationToken.None);
                await io.WriteAsync("bridged"u8.ToArray(), CancellationToken.None);
                upgraded = true;
            });

        Assert.True(sawBody);
        Assert.True(upgraded);
        Assert.Contains("HTTP/1.1 101", response, StringComparison.Ordinal);
        Assert.Contains("multiplexed-stream", response, StringComparison.Ordinal);
        Assert.EndsWith("bridged", response, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnswersNotFoundWhenNothingHandledTheRequest()
    {
        var response = await ServeAsync(
            "GET /nonsense HTTP/1.1\r\n\r\n",
            (_, _) => Task.CompletedTask);

        Assert.Contains("HTTP/1.1 404", response, StringComparison.Ordinal);
    }

    // -- helpers -------------------------------------------------------------

    private static ShimContainer Container(params (string Key, string Value)[] labels)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (key, value) in labels)
        {
            map[key] = value;
        }

        return new ShimContainer { Id = new string('a', 64), Name = "vsc-demo", Instance = "vsc-demo", Labels = map };
    }

    /// <summary>Feed a raw request over a duplex and return everything written back, as text.</summary>
    private static async Task<string> ServeAsync(string request, Func<ShimRequest, ShimResponse, Task> handler)
    {
        var duplex = new DuplexStream(Encoding.ASCII.GetBytes(request));
        await using var http = new ShimHttp(duplex);
        await http.ServeAsync(handler, CancellationToken.None);
        return Encoding.ASCII.GetString(duplex.Written);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;

        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    /// <summary>A connection whose reads come from a fixed request and whose writes are captured.</summary>
    private sealed class DuplexStream(byte[] request) : Stream
    {
        private readonly MemoryStream _in = new(request);
        private readonly MemoryStream _out = new();

        public byte[] Written => _out.ToArray();

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) =>
            _in.ReadAsync(buffer, ct);

        public override int Read(byte[] buffer, int offset, int count) => _in.Read(buffer, offset, count);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) =>
            _out.WriteAsync(buffer, ct);

        public override void Write(byte[] buffer, int offset, int count) => _out.Write(buffer, offset, count);

        public override void Flush()
        {
        }

        public override Task FlushAsync(CancellationToken ct) => Task.CompletedTask;

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
