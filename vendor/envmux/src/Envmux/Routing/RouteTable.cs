using Envmux.Config;
using Envmux.Host;
using Envmux.Session;

namespace Envmux.Routing;

/// <summary>One declared route: a port on this session's instance.</summary>
/// <param name="Name">The route's key in <c>routes</c>. A label, not part of the address.</param>
/// <param name="Port">The port the server listens on inside the instance.</param>
/// <param name="Hostname">The session's own name in the zone, which every route shares.</param>
/// <param name="Scheme">What the server on that port speaks — usually http or https.</param>
internal sealed record RoutedEndpoint(
    string Name,
    int Port,
    string Hostname,
    string Scheme = Config.RouteConfig.Http)
{
    /// <summary>
    /// The task whose output this route's URL is read from, when one declared
    /// a <c>url</c> pattern for it. Null for a route that is just its port.
    /// </summary>
    public string? PinnedBy { get; init; }

    /// <summary>
    /// The URL that task printed, moved onto <c>localhost</c>. Null until it has
    /// printed one.
    /// </summary>
    public string? Pinned { get; init; }

    /// <summary>
    /// The URL a person opens, in the session's browser: the port on
    /// <c>localhost</c> — or, once the task behind it has said so, the URL it
    /// printed, on <c>localhost</c> whatever it bound.
    /// </summary>
    /// <remarks>
    /// <c>localhost</c>, not the session's name, because nothing on this
    /// machine resolves or routes to the instance any more. The session's
    /// browser carries <c>localhost</c> into it (docs/pages/browser.md), which
    /// also reaches a server bound to the instance's own loopback, and needs no
    /// certificate for a secure context.
    /// </remarks>
    public string Url => Pinned ?? $"{Scheme}://localhost:{Port}/";

    /// <summary>Whether <see cref="Url"/> is the one the task printed rather than the one composed from the port.</summary>
    public bool IsPinned => Pinned is not null;

    /// <summary>Whether this one is reached over TLS.</summary>
    public bool Tls => Scheme.Equals(Config.RouteConfig.Https, StringComparison.Ordinal);

    /// <summary>
    /// This route, showing the URL its task printed.
    /// </summary>
    /// <remarks>
    /// The host is rewritten to <c>localhost</c>, because a server that bound
    /// <c>0.0.0.0</c> or its own name printed that, and in the session's browser
    /// only <c>localhost</c> is the instance. The path and query are the task's.
    /// </remarks>
    public RoutedEndpoint Pin(string printed) => this with { Pinned = PinnedUrl.Rewrite(printed, Localhost) };

    /// <summary>The name that, in the session's browser, is the instance.</summary>
    public const string Localhost = "localhost";
}

/// <summary>
/// The hostname scheme, which is now the whole of the routing.
/// </summary>
/// <remarks>
/// <para>
/// There is no table any more, and no proxy. An instance has an address of its
/// own on <c>envmux0</c>, dnsmasq on that bridge answers for it under the zone,
/// and a route is a port on it. <c>http://envmux-docs.envmux:5173</c> is the
/// server's own port on the server's own address, with nothing in between.
/// </para>
/// <para>
/// That deletes the problem the previous design was built around. Under Docker
/// on Windows every environment was flattened onto one host port space, so two
/// sessions could not both have 3000, ports had to be allocated and remembered,
/// and an application that generated an absolute URL emitted the port it was
/// bound to rather than the one it was reached on. The relay, the port walk, the
/// per-route hostnames and the reverse proxy that matched on them were all
/// consequences of that one flattening, and all of them are gone with it.
/// </para>
/// <para>
/// So a route name is a label — for the list, for the log line — and not part of
/// an address. Two routes on one session differ by port, which is what they
/// differ by inside the instance too.
/// </para>
/// </remarks>
internal static class RouteTable
{
    /// <summary>The separator between the project and the session in a name.</summary>
    /// <remarks>
    /// A hyphen, because this string is a DNS label and an Incus instance name
    /// at the same time, and both permit exactly letters, digits and hyphens.
    /// </remarks>
    public const char Delimiter = '-';

    /// <summary>
    /// The zone, which comes from the host rather than from the project.
    /// </summary>
    /// <remarks>
    /// <para>
    /// It is served by dnsmasq on the bridge and resolved through one NRPT rule
    /// on this workstation, so every project on a machine shares it. A project
    /// that wanted its own zone would need its own bridge, its own route and its
    /// own resolver policy — which is a host-level decision, and lives in
    /// <c>host.json</c>.
    /// </para>
    /// <para>
    /// Read once. Every route of every session would otherwise open that file,
    /// and the answer cannot change while a process is running — the zone is
    /// baked into the host's dnsmasq, not into this.
    /// </para>
    /// </remarks>
    public static string DefaultDomain => _domain ??= ReadDomain();

    private static string? _domain;

    private static string ReadDomain()
    {
        try
        {
            return HostConfig.Load().DnsDomain;
        }
        catch (Exception e) when (e is IOException or ConfigException or UnauthorizedAccessException)
        {
            // A host that has not been configured, or a file being rewritten as
            // this was read. Neither is a reason to refuse to resolve a plan,
            // and the default is what an unconfigured host would have said.
            return HostConfig.DefaultDnsDomain;
        }
    }

    /// <summary>
    /// The instance's name, which is also its hostname's first label.
    /// </summary>
    /// <remarks>
    /// One string doing two jobs, deliberately: Incus registers an instance in
    /// the bridge's DNS under its own name, so making the name and the label
    /// the same thing is what makes <c>{name}.{zone}</c> resolve without
    /// anything else being told anything.
    /// </remarks>
    public static string InstanceName(string project, string session) =>
        $"{Slug.From(project)}{Delimiter}{Slug.From(session)}";

    /// <summary>Where a session answers: <c>{project}-{session}.{zone}</c>.</summary>
    public static string Hostname(string project, string session, string domain) =>
        $"{InstanceName(project, session)}.{domain.Trim('.').ToLowerInvariant()}";

    /// <summary>A service's instance name, which is the session's with the service appended.</summary>
    public static string ServiceInstanceName(string project, string session, string service) =>
        $"{InstanceName(project, session)}{Delimiter}{Slug.From(service)}";

    /// <summary>
    /// Resolve every declared route, ordered by name so every view lists them
    /// the same way.
    /// </summary>
    /// <exception cref="ConfigException">A route declares a port outside 1–65535.</exception>
    public static IReadOnlyList<RoutedEndpoint> Build(
        string project,
        string session,
        string domain,
        IReadOnlyDictionary<string, RouteConfig>? routes)
    {
        if (routes is null || routes.Count == 0)
        {
            return [];
        }

        var hostname = Hostname(project, session, domain);
        var endpoints = new List<RoutedEndpoint>(routes.Count);

        foreach (var (route, declared) in routes.OrderBy(r => r.Key, StringComparer.Ordinal))
        {
            if (declared.Port is < 1 or > 65535)
            {
                throw new ConfigException($"route '{route}' declares port {declared.Port}, which is not a port");
            }

            endpoints.Add(new RoutedEndpoint(route, declared.Port, hostname, declared.Scheme));
        }

        // Two routes on the same port would be one address listed twice, which
        // reads as a routing feature and is a mistake in the declaration.
        var duplicate = endpoints.GroupBy(e => e.Port).FirstOrDefault(g => g.Count() > 1);

        return duplicate is null
            ? endpoints
            : throw new ConfigException(
                $"routes {string.Join(" and ", duplicate.Select(e => $"'{e.Name}'"))} both declare port " +
                $"{duplicate.Key} — with one address per session there is nothing left to tell them apart");
    }

    /// <summary>
    /// Say which route each <c>url</c>-declaring task speaks for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two rules, both of them shapes the declaration already has. A task with
    /// <c>ready: 17178</c> and a route on 17178 are the same server — the port
    /// that means "up" is the port the route is on — so the URL that task
    /// prints is that route's URL. Failing that, a task and a route with the
    /// same name are the same thing, which is the one-task-per-route shape
    /// <c>autoconfigure</c> asks for. There is no third field to write: a
    /// <c>route</c> on the task would be a second way of saying what
    /// <c>ready</c> or the name already says, and a second way is a way to
    /// disagree.
    /// </para>
    /// <para>
    /// A <c>url</c> that pins nothing is refused rather than ignored. It would
    /// otherwise be a pattern that matched, a token that was captured, and a
    /// routes pane that went on showing the bare port — the same silent
    /// nothing a misspelled <c>dependsOn</c> would be, and refused for the same
    /// reason.
    /// </para>
    /// </remarks>
    /// <exception cref="ConfigException">
    /// A task declares a <c>url</c> and no route is on its <c>ready</c> port or
    /// shares its name, or two tasks claim one route.
    /// </exception>
    public static IReadOnlyList<RoutedEndpoint> Pin(
        IReadOnlyList<RoutedEndpoint> routes,
        IReadOnlyList<TaskPlan> tasks)
    {
        var pinned = routes.ToList();

        foreach (var task in tasks.Where(t => t.UrlPattern is not null))
        {
            var at = task.ReadyPort is { } port ? pinned.FindIndex(r => r.Port == port) : -1;

            if (at < 0)
            {
                at = pinned.FindIndex(r => Slug.From(r.Name).Equals(task.Name, StringComparison.Ordinal));
            }

            if (at < 0)
            {
                var have = pinned.Count == 0
                    ? "there are no routes"
                    : $"the routes are {string.Join(", ", pinned.Select(r => $"{r.Name}:{r.Port}"))}";

                throw new ConfigException(
                    $"task '{task.Name}' has a 'url' but no route to show it on — give it 'ready': <port> " +
                    $"matching a route's port, or call a route '{task.Name}'. Right now {have}.");
            }

            if (pinned[at].PinnedBy is { } other)
            {
                throw new ConfigException(
                    $"tasks '{other}' and '{task.Name}' both have a 'url' for route '{pinned[at].Name}' — " +
                    "one route shows one URL");
            }

            pinned[at] = pinned[at] with { PinnedBy = task.Name };
        }

        return pinned;
    }
}
