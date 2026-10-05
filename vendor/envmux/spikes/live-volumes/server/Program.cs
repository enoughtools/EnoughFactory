using System.Net;
using System.Net.Sockets;
using System.Text.Json;

using Envmux.Live;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// envmux-live — the workstation half of a session's live volumes.
//
//   envmux-live --session <name> [--listen <ip>] [--port <n>] [--admin-port <n>]
//               [--task <name>=<scope>]... [--live claude/projects]... [--print]
//
// Serves this workstation's coding-tool state as read-write WebDAV, filtered by
// the policy in Policy.cs and by the scope of the key each task was minted, and
// prints what the guest needs to mount it.

var session = Argument(args, "--session") ?? "spike";
var listen = Argument(args, "--listen") ?? BridgeFacingAddress();
var port = int.TryParse(Argument(args, "--port"), out var p) ? p : 8079;
var adminPort = int.TryParse(Argument(args, "--admin-port"), out var a) ? a : port + 1;
var verbose = args.Contains("--verbose");

// What the session is a checkout of, and where it lands inside the instance.
// Both are needed to rewrite .claude.json: one to recognise this workstation's
// paths, the other to say what they become.
var project = Argument(args, "--project") ?? Environment.CurrentDirectory;
var workdir = Argument(args, "--workdir") ?? "/work";

// The account the session runs as, which fixes where the tool state directory
// is inside the instance — the second root that has to be rewritten.
var guestHome = Argument(args, "--home") ?? "/home/matt";

// --plugin prompt-context@prompt-skills, repeatable, optionally with
// =github:Owner/repo when this workstation has no record of the marketplace.
// Standing in for the `plugins` list in .envmux.json. None declared is none
// carried.
var plugins = args
    .Select((value, index) => (value, index))
    .Where(x => x.value == "--plugin" && x.index + 1 < args.Length)
    .Select(x => PluginSpec.Parse(args[x.index + 1]))
    .ToList();

// --live claude/projects, repeatable: promote one entry from the session's own
// storage to the workstation's. This is `envmux live sync` before it has a
// command of its own.
var overrides = args
    .Select((value, index) => (value, index))
    .Where(x => x.value is "--live" or "--local" && x.index + 1 < args.Length)
    .ToDictionary(x => args[x.index + 1], x => x.value[2..], StringComparer.OrdinalIgnoreCase);

var overlay = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    ".envmux", "live", session);

Directory.CreateDirectory(overlay);

var auditPath = Path.Combine(overlay, "audit.log");
var auditLock = new Lock();

var tree = new Tree(Policy.For(overrides), overlay);

// The session's copy of every shadowed file it should not start from scratch
// on. Made once: after this the session owns it, and a second run of the server
// against the same session must not throw away what the session has written.
foreach (var (name, transform) in Seeds())
{
    var destination = Path.Combine(overlay, name.Replace('/', Path.DirectorySeparatorChar));

    if (File.Exists(destination))
    {
        continue;
    }

    var resolved = tree.Resolve(name);

    if (resolved.FallbackPath is not { } from || !File.Exists(from))
    {
        continue;
    }

    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
    File.WriteAllBytes(destination, transform(File.ReadAllBytes(from)));
}

IEnumerable<(string Name, Func<byte[], byte[]> Transform)> Seeds()
{
    var claude = tree.Namespaces.First(n => n.Name == "claude");
    var projectMapping = new PathMapping(project, workdir);

    // Longest root wins inside Map, so a project that happens to live under
    // the state directory would still map as the project.
    IReadOnlyList<PathMapping> mappings =
    [
        projectMapping,
        new PathMapping(claude.HostRoot, $"{guestHome}/.claude"),
    ];

    yield return ("claude/.claude.json", bytes => Seed.ClaudeJson(bytes, projectMapping, mappings));
    yield return ("claude/settings.json", bytes => Seed.Settings(bytes, plugins));
    yield return ("claude/plugins/installed_plugins.json", bytes => Seed.InstalledPlugins(bytes, plugins, mappings));
    yield return ("claude/plugins/known_marketplaces.json", bytes => Seed.KnownMarketplaces(bytes, plugins, mappings));
}
var grants = new Grants();
// --git-host github.com, repeatable: the hosts a task with git in its scope may
// ask this workstation's credential helper about. envmux passes the hosts the
// repository's remotes point at. None declared is an empty git directory.
var gitHosts = args
    .Select((value, index) => (value, index))
    .Where(x => x.value == "--git-host" && x.index + 1 < args.Length)
    .Select(x => args[x.index + 1])
    .ToList();

var vault = new GitVault(gitHosts);
var dav = new Dav(tree, grants, vault, Audit);

// The admin key is not a task key: it mints and revokes, and it is only ever
// presented over loopback. envmux itself holds it for the life of the session.
var (_, adminKey) = grants.Issue("envmux", Scope.Nothing, DateTimeOffset.MaxValue);

// --task agent=claude, --task build=claude:plugins,settings.json, --task docs=
var issued = args
    .Select((value, index) => (value, index))
    .Where(x => x.value == "--task" && x.index + 1 < args.Length)
    .Select(x => args[x.index + 1])
    .Select(spec =>
    {
        var equals = spec.IndexOf('=', StringComparison.Ordinal);
        var task = equals < 0 ? spec : spec[..equals];
        var scope = equals < 0 ? Scope.Nothing : Scope.Parse(spec[(equals + 1)..]);
        var (grant, key) = grants.Issue(task, scope);

        return new { task = grant.Task, id = grant.Id, scope = scope.ToString(), key, expires = grant.Expires };
    })
    .ToList();

var builder = WebApplication.CreateSlimBuilder();

builder.Logging.ClearProviders();

if (verbose)
{
    builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
    builder.Logging.SetMinimumLevel(LogLevel.Warning);
}

builder.WebHost.ConfigureKestrel(k =>
{
    // Kestrel binds a socket rather than registering a URL prefix with http.sys,
    // which is what keeps this out of `netsh urlacl` and out of an elevated
    // prompt. The volumes answer on the one interface the Incus host can reach;
    // minting and revoking answer on loopback and nowhere else, so a key can
    // only be issued by something already running on this workstation.
    k.Listen(IPAddress.Parse(listen), port);
    k.Listen(IPAddress.Loopback, adminPort);
    k.AddServerHeader = false;

    // A FUSE mount is a long series of very small requests. The default limits
    // are for browsers.
    k.Limits.MaxRequestBodySize = null;
    k.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(10);
});

var app = builder.Build();

app.Run(async context =>
{
    if (verbose)
    {
        var depth = context.Request.Headers["Depth"].Count > 0
            ? $" depth={context.Request.Headers["Depth"]}"
            : "";

        Console.Error.WriteLine($"{context.Request.Method,-8} {context.Request.Path}{depth}");
    }

    if (context.Connection.LocalPort == adminPort)
    {
        await AdminAsync(context);
        return;
    }

    await dav.HandleAsync(context);
});

var description = new
{
    session,
    project,
    workdir,
    guestHome,
    plugins = plugins.Select(p => p.Key),
    gitHosts,
    url = $"http://{listen}:{port}",
    admin = $"http://127.0.0.1:{adminPort}",
    adminKey,
    overlay,
    tasks = issued,
    namespaces = tree.Namespaces.Select(n => new
    {
        name = n.Name,
        root = n.HostRoot,
        live = n.Live.OrderBy(x => x, StringComparer.Ordinal),
        shadow = n.Shadow.OrderBy(x => x, StringComparer.Ordinal),
        local = n.Local.OrderBy(x => x, StringComparer.Ordinal),
    }),
};

Console.WriteLine(JsonSerializer.Serialize(description, new JsonSerializerOptions { WriteIndented = true }));
Console.Out.Flush();

if (args.Contains("--print"))
{
    return;
}

await app.RunAsync();

// ---------------------------------------------------------------------------

/// <summary>
/// Mint, list and revoke task keys, over loopback.
/// </summary>
/// <remarks>
/// This is the seam envmux's task runner uses: a task is about to start, so its
/// key is minted with the scope its declaration asked for and handed to it in
/// its own environment; the task ends, so the key is revoked before the next
/// one starts. Nothing on the bridge can reach this listener, and it wants the
/// admin key as well, so a session cannot mint itself a wider key than it was
/// given.
/// </remarks>
async Task AdminAsync(HttpContext context)
{
    var header = context.Request.Headers.Authorization.ToString();

    if (!header.StartsWith("Bearer ", StringComparison.Ordinal) || header[7..] != adminKey)
    {
        context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
        return;
    }

    var path = context.Request.Path.Value ?? "/";

    if (context.Request.Method == "POST" && path == "/grant")
    {
        var task = context.Request.Query["task"].ToString();
        var scope = Scope.Parse(context.Request.Query["scope"].ToString());
        var (grant, key) = grants.Issue(task.Length == 0 ? "unnamed" : task, scope);

        await context.Response.WriteAsJsonAsync(new
        {
            id = grant.Id,
            task = grant.Task,
            scope = scope.ToString(),
            key,
            expires = grant.Expires,
        });

        Audit($"{DateTimeOffset.UtcNow:O} envmux - ISSUE {grant.Task}/{grant.Id} [{scope}]");
        return;
    }

    if (context.Request.Method == "DELETE" && path.StartsWith("/grant/", StringComparison.Ordinal))
    {
        var id = path["/grant/".Length..];
        context.Response.StatusCode = grants.Revoke(id)
            ? (int)HttpStatusCode.NoContent
            : (int)HttpStatusCode.NotFound;

        Audit($"{DateTimeOffset.UtcNow:O} envmux - REVOKE {id}");
        return;
    }

    if (context.Request.Method == "GET" && path == "/grants")
    {
        await context.Response.WriteAsJsonAsync(grants.All
            .Select(g => new { g.Id, g.Task, scope = g.Scope.ToString(), g.Expires })
            .OrderBy(g => g.Task, StringComparer.Ordinal));
        return;
    }

    context.Response.StatusCode = (int)HttpStatusCode.NotFound;
}

/// <summary>
/// Every read of the workstation's own state, with the task that asked.
/// </summary>
/// <remarks>
/// Scoped keys decide what a task may read; this is what makes it answerable
/// afterwards. Appended rather than buffered, because the question it exists to
/// answer — "what got at my credential?" — is asked after something has gone
/// wrong, which is exactly when a buffer is lost.
/// </remarks>
void Audit(string line)
{
    lock (auditLock)
    {
        File.AppendAllText(auditPath, line + Environment.NewLine);
    }
}

static string? Argument(string[] args, string name)
{
    var i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

/// <summary>
/// The address on this workstation that a session's instance can reach.
/// </summary>
/// <remarks>
/// <para>
/// Not loopback: the guest is a container on a bridge inside a VM, and the only
/// thing on this machine it can open a socket to is an address on the switch
/// that VM is attached to. Not <c>0.0.0.0</c> either — this endpoint hands out
/// the credential the workstation signs in with, and it has no business
/// answering on the café wifi.
/// </para>
/// <para>
/// Found rather than configured: the route to the Incus host is the route the
/// answer comes back on, so the local endpoint of a socket opened towards the
/// API is exactly the address to listen on. One less thing in host.json to go
/// stale when DHCP moves the VM.
/// </para>
/// </remarks>
static string BridgeFacingAddress()
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var api = JsonDocument.Parse(File.ReadAllText(Path.Combine(home, ".envmux", "host.json")))
        .RootElement.GetProperty("api").GetString()!;

    using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
    probe.Connect(IPAddress.Parse(api.Split(':')[0]), 65530);

    return ((IPEndPoint)probe.LocalEndPoint!).Address.ToString();
}
