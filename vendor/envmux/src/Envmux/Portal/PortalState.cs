using System.Text.Json;
using System.Text.Json.Serialization;

using Envmux.Session;

namespace Envmux.Portal;

/// <summary>One route, as the page shows it.</summary>
/// <param name="Portal">
/// Whether this is the portal itself rather than something proxied — the page
/// is listing the address it is being read at, which is worth a tag and worth
/// saying with the token still on it, because that is the form of the link that
/// opens in a browser that has never been here.
/// </param>
internal sealed record PortalRoute(
    string Name,
    int Port,
    string Url,
    string Hostname,
    bool Portal);

/// <summary>One task, as the page shows it.</summary>
internal sealed record PortalTask(
    string Name,
    string Command,
    string Status,
    string State,
    string Kind,
    bool Internal,
    int Runs,
    string? StartedAt,
    string LastLine);

/// <summary>One service container, as the page shows it.</summary>
/// <remarks>
/// No password, and no connection string. The session container is told those;
/// a browser tab has no use for them, and the difference between a page that
/// shows them and one that does not is the difference between a screenshot
/// being safe to paste and not.
/// </remarks>
internal sealed record PortalService(string Name, string Type, string Image, string Host, int Port, bool Persist);

/// <summary>One log line.</summary>
internal sealed record PortalLogLine(string At, string Level, string Message);

/// <summary>
/// The whole session, as one JSON object.
/// </summary>
/// <remarks>
/// <para>
/// Composed from the session every time it is asked for, exactly as the
/// terminal frame is. There is no view model on this side either: the session
/// is the only copy of the truth, and a snapshot of it is small enough
/// — a few kilobytes with the log in it — that sending the whole thing beats
/// keeping two ends of a diff in agreement.
/// </para>
/// <para>
/// The log is the tail rather than the ring. Five hundred lines on every push
/// would make the stream the largest thing in the process; what the page shows
/// is the recent end of it, and what it does not show has already been read.
/// </para>
/// </remarks>
internal sealed record PortalState(
    string Project,
    string Session,
    string Branch,
    string Base,
    string Image,
    string Address,
    string InstanceName,
    string Workdir,
    string Shell,
    string Domain,
    int Port,
    string Phase,
    bool Ready,
    string? Failed,
    string StartedAt,
    string? Editor,
    string EditorAttach,
    int BrowserPort,
    IReadOnlyList<PortalRoute> Routes,
    IReadOnlyList<PortalTask> Tasks,
    IReadOnlyList<PortalService> Services,
    IReadOnlyList<string> Tools,
    IReadOnlyList<PortalLogLine> Log)
{
    /// <summary>How many log lines travel with a snapshot.</summary>
    private const int LogTail = 200;

    /// <summary>
    /// camelCase, because the other end of this is TypeScript.
    /// </summary>
    /// <remarks>
    /// Written down once here rather than configured on the host: these types
    /// are the only ones serialised, and the page is the only reader.
    /// </remarks>
    public static readonly JsonSerializerOptions Json = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static PortalState Of(Session.Session session)
    {
        var plan = session.Plan;
        var port = session.Port;

        // Only the tools there is something to open: a mounted tool that is a
        // session of its own, rather than one whose state is mounted so that
        // something else is authenticated.
        var tools = ToolMounts.Launchable(session.Tools);

        return new PortalState(
            plan.Project,
            plan.Session,
            plan.Branch,
            plan.Base,
            plan.Image,
            session.Address,
            plan.InstanceName,
            plan.Workdir,
            plan.Shell,
            plan.Domain,
            port,
            session.Phase,
            session.IsReady,
            session.FailedWith,
            session.StartedAt.ToString("O"),
            session.EditorUri,
            plan.Editor.IsDevContainer ? Config.EditorAttach.DevContainer : Config.EditorAttach.Ssh,
            session.BrowserPort,
            [.. session.Listed.Select(r => new PortalRoute(
                r.Name,
                r.Port,
                r.Url,
                r.Hostname,
                r.IsPortal))],
            [.. session.Tasks.Select(t => new PortalTask(
                t.Plan.Name,
                t.Plan.Display,
                t.Status,
                t.State.ToString().ToLowerInvariant(),
                t.Plan.Kind.ToString().ToLowerInvariant(),
                t.Plan.IsInternal,
                t.Runs,
                t.StartedAt?.ToString("O"),
                t.LastLine))],
            [.. plan.Services.Select(s => new PortalService(
                s.Name, s.Type, s.Image, s.Host, s.Port, s.Persist))],
            tools,
            [.. session.Log.Entries.TakeLast(LogTail).Select(e => new PortalLogLine(
                e.At.ToString("O"), e.Level, e.Message))]);
    }

    public string ToJson() => WireJson.Serialize(this, Json);
}
