using Envmux.Portal;
using Envmux.Session;

namespace Envmux.Routing;

/// <summary>One row of the routes list.</summary>
/// <param name="Name">What it is called in the list.</param>
/// <param name="Port">The port the server listens on. Zero for the portal, which is not in the instance.</param>
/// <param name="Url">The link to open, token and all when it is the portal's.</param>
/// <param name="Hostname">The name it answers on.</param>
/// <param name="IsPortal">Whether this row is the page about the session rather than something in it.</param>
/// <param name="IsPinned">Whether <paramref name="Url"/> is the one the task behind it printed, rather than the port alone.</param>
internal sealed record ListedRoute(
    string Name,
    int Port,
    string Url,
    string Hostname,
    bool IsPortal = false,
    bool IsPinned = false);

/// <summary>
/// The routes as anything that lists them shows them, portal included.
/// </summary>
/// <remarks>
/// <para>
/// The portal is the odd one out and always was: it is a page <em>about</em> the
/// session, served by this process on loopback, rather than something running
/// inside the instance. It is listed anyway, first and under a name of its own,
/// because it is still a URL somebody wants to open.
/// </para>
/// <para>
/// Pure, and shared by both views, so the window's pane and the page's sidebar
/// list the same things in the same order rather than each deciding.
/// </para>
/// </remarks>
internal static class RouteListing
{
    /// <summary>
    /// What the portal is listed as.
    /// </summary>
    /// <remarks>
    /// Not a reserved word any more. A route called <c>envmux</c> is a port on
    /// the session's own address, and the portal is on loopback — they cannot
    /// collide, because they are not in the same address space at all. The list
    /// would show two rows with one name, which is a readability problem and no
    /// longer a routing one.
    /// </remarks>
    public const string PortalName = "envmux";

    /// <param name="plan">The session, for its routes and its portal.</param>
    /// <param name="port">The loopback port the portal claimed. Zero for none yet.</param>
    /// <param name="address">The instance's address. Empty until it has one.</param>
    /// <param name="printed">
    /// What each <c>url</c>-declaring task has printed so far, by task name, as
    /// printed. The route it pins does the rewriting, because the route knows
    /// the hostname and the task only knows what its server said.
    /// </param>
    public static IReadOnlyList<ListedRoute> Build(
        SessionPlan plan,
        int port,
        string address,
        IReadOnlyDictionary<string, string>? printed = null)
    {
        var listed = new List<ListedRoute>(plan.Routes.Count + 1);

        // No port means no listener yet, and so no URL that would answer.
        if (plan.Portal.Enabled && port > 0)
        {
            listed.Add(new ListedRoute(
                PortalName,
                0,
                plan.Portal.Url(port),
                PortalPlan.Loopback,
                IsPortal: true));
        }

        // No address means the instance has not come up, and every one of these
        // would be a name that does not resolve yet.
        if (address.Length == 0)
        {
            return listed;
        }

        foreach (var declared in plan.Routes)
        {
            var route = declared.PinnedBy is { } task && printed?.TryGetValue(task, out var url) is true
                ? declared.Pin(url)
                : declared;

            listed.Add(new ListedRoute(route.Name, route.Port, route.Url, route.Hostname, IsPinned: route.IsPinned));
        }

        return listed;
    }
}
