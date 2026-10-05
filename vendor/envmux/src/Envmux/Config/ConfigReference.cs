using System.Text;

namespace Envmux.Config;

/// <summary>One field of <c>.envmux.json</c>, as documentation.</summary>
/// <param name="Path">Dotted path, as it appears in the file.</param>
/// <param name="Type">What shape the value takes.</param>
/// <param name="Default">What happens if it is absent.</param>
/// <param name="Description">What it does.</param>
internal sealed record ConfigField(string Path, string Type, string Default, string Description);

/// <summary>
/// Every field envmux accepts, in one place.
/// </summary>
/// <remarks>
/// Read by <c>envmux config schema</c> and embedded in the prompt
/// <c>envmux autoconfigure</c> emits, so the reference an agent is handed
/// cannot drift from the one a person reads — or from the loader, which rejects
/// anything not listed here.
/// </remarks>
internal static class ConfigReference
{
    public static readonly IReadOnlyList<ConfigField> Fields =
    [
        new("name", "string", "the directory name, slugified",
            "Project label — the first part of this session's hostname."),
        new("chef", "bool", "false",
            "Give the session named chef a separate guest capability to list, dispatch, and stop workers " +
            "in this repository. At most three active workers. Requires the portal and its token. " +
            "Workers do not inherit dispatch authority."),
        new("image", "string", SessionConfig.DefaultImage,
            "The image an instance is created from when there is no golden snapshot to copy. " +
            "An alias on the official remote. Rarely worth setting: a copy is seconds where a " +
            "pull is minutes."),
        new("workdir", "string", SessionConfig.DefaultWorkdir,
            "Where the repository is cloned inside the instance, and the working directory."),
        new("shell", "string", SessionConfig.DefaultShell,
            "What the shell key hands you. Must exist in the instance."),
        new("editor", "path, or an object", "found on this machine",
            "How the 'e' key attaches VS Code to the instance, over SSH. A path like \"code\", or " +
            "{ \"path\": ..., \"newWindow\": true, \"folder\": \"/work\" }. Needs the Remote-SSH " +
            "extension installed in that editor."),
        new("tasks", "object of name → command", "{}",
            "Everything that runs inside the session's instance: dev servers, watchers, workers, " +
            "and the installs and migrations they need. Services are separate machines; tasks are " +
            "processes in this one. A command like \"npm run dev\", or an object — see below."),
        new("env", "object of string", "{}",
            "Literal environment variables. No interpolation, no secret references."),
        new("envFile", "path or list of paths", "none",
            "Files on this machine to read the environment from, relative to the project. " +
            "For the gitignored .env the bundle does not carry. Missing files are skipped."),
        new("features", "object of reference → options", "{}",
            "Dev container features to install, spelled as devcontainer.json spells them. " +
            "Installed once into a project image every session is copied from."),
        new("routes", "object of name → port, or { port, tls, scheme }", "{}",
            "Ports this session serves, named. Each is opened at http://localhost:{port}/ in the " +
            "session's browser (the b key, or Enter on it), whose localhost is the instance — so a " +
            "server bound to the instance's own 127.0.0.1 is reachable too. The name is a label for " +
            "the list. Write { \"port\": n, \"tls\": true } when the server on it speaks TLS, or " +
            "{ \"port\": n, \"scheme\": \"postgres\" } when it is not HTTP at all."),
        new("backend", "\"incus\" | \"docker\"", "docker",
            "What the session runs on: an Incus host (a VM envmux built, or one it attached to), or the " +
            "Docker engine on this machine. `--backend` on the command line wins over this."),
        new("port", "number or [first, last]", "8080",
            "The loopback port the portal is served on, or the range to claim within. The only " +
            "port envmux allocates; a route's is whatever the server binds."),
        new("domain", "string", "the host's dns domain, usually 'envmux'",
            "The domain the session's instance and its services are named under inside the host — " +
            "how a task reaches a service, e.g. myproj-feat-login-db.envmux. Nothing on this machine " +
            "resolves it; the session's proxy carries names under it into the instance, and ssh " +
            "uses it for its aliases. Changing it per project only works if the host serves it too."),
        new("tls", "bool", "ignored",
            "No longer does anything, and read only so an older .envmux.json still loads. envmux " +
            "issued each session a certificate for its own name; a session is now opened at " +
            "localhost in its own browser, which is a secure context over plain http."),
        new("services", "object of name → service", "{}",
            "Machines the session depends on, each with an address and a name of its own. " +
            "See the service fields below."),
        new("generate", "object of NAME → kind", "{}",
            "Environment variables envmux invents once per session. " +
            "Kinds: password, token, hex, uuid. Long form: { \"kind\": \"token\", \"length\": 48 }."),
        new("tools", "object of name → \"auto\"|\"off\"|path", "{}",
            "Host coding-tool state to copy in so agents arrive signed in. " +
            "Known: claude, codex, gemini, opencode, gh, git. 'git' carries this host's git credentials."),
        new("portal.enabled", "bool", "true",
            "Serve the session as a page: tasks, their output, the routes, and a shell in the " +
            "instance. Reachable from 127.0.0.1 only, because that is where the listener is bound."),
        new("portal.token", "bool", "true",
            "Ask for a per-session token before answering. The window prints the URL with it on. " +
            "Turn it off and anything on this machine that can reach the port gets a shell in " +
            "your instance."),
        new("portal.open", "bool", "false",
            "Open a browser at the portal when the session starts."),
        new("browser.enabled", "bool", "true",
            "Claim a SOCKS5 port on 127.0.0.1 for this session. The 'b' key opens Chrome, Firefox or " +
            "Edge on a profile of its own behind it, and in that browser localhost:3000 is port 3000 " +
            "inside the instance — even a server bound to the instance's own 127.0.0.1. " +
            "No route, DNS or certificate is involved."),
        new("browser.egress", "\"local\" | \"instance\"", BrowserConfig.EgressLocal,
            "Where that browser's other traffic leaves from. 'local' dials from this machine, so " +
            "maps, fonts and single sign-on work as they do in any other browser here; 'instance' " +
            "sends everything through the instance and its DNS."),
        new("browser.port", "number or [first, last]", "1080",
            "The loopback port the proxy claims, or the range to claim within. Walks upward from " +
            "a single port when it is taken."),
        new("browser.use", "\"chrome\" | \"firefox\" | \"edge\" | path", "the first found, in that order",
            "Which browser the 'b' key opens."),
        new("browser.color", "\"#rrggbb\"", "one of ten, picked from the session's name",
            "The Chrome or Edge profile's colour theme, so a session's window is told apart at a glance. " +
            "Set when the profile is first made; changing it in the browser afterwards sticks."),
        new("browser.open", "route name or URL", "the first web route, by name",
            "Where that browser starts. A route opens at http://localhost:<port>/, which in that " +
            "browser is the instance. A name that is not a route is an error."),
        new("git.branchPrefix", "string", GitConfig.DefaultBranchPrefix,
            "Prefixed to the session name to make the branch."),
        new("git.base", "string", GitConfig.DefaultBase,
            "What a session's branch is created from."),
        new("git.keepOnExit", "bool", "true",
            "Whether the instance outlives the session. Commits come back to this repository " +
            "when it ends; anything uncommitted lives only in the instance, so it is kept either " +
            "way when the tree is dirty. `envmux prune` is how a kept instance goes."),
    ];

    /// <summary>Fields of one entry in <c>tasks</c>.</summary>
    public static readonly IReadOnlyList<ConfigField> TaskFields =
    [
        new("command", "string or list", "required",
            "What to run. A string is given to a login shell; a list is exec'd unchanged."),
        new("kind", "\"ongoing\" | \"once\"", "ongoing",
            "Whether it is expected to finish. 'once' is a migration or an install — it must exit " +
            "zero, and anything depending on it waits until it has."),
        new("dependsOn", "name or list of names", "[]",
            "Tasks and services that must be up first. A service is up when it accepts a " +
            "connection; an ongoing task when it is running, or when its 'ready' port answers."),
        new("ready", "number", "none",
            "The port that, once it accepts inside the instance, means this task is up. " +
            "Only useful on an ongoing task something else depends on."),
        new("url", "regular expression", "none",
            "Where in this task's output its URL is, for a server whose URL carries a secret it " +
            "made up — Aspire's dashboard prints one with a login token on it. The first capture " +
            "group is the URL (or the whole match); the first line that matches wins, until the " +
            "task restarts. Its host is rewritten to this session's name and the port, path and " +
            "query kept as printed. Shown on the route whose port is this task's 'ready' port, or " +
            "failing that the route with this task's name — one of those must exist. " +
            "Like \"Login to the dashboard at (https://\\\\S+)\"."),
        new("workdir", "string", "the session's workdir",
            "Where to run it."),
        new("env", "object of string", "{}",
            "Extra environment, on top of the session's own."),
        new("autostart", "bool", "true",
            "Whether envmux starts it. False declares it without running it."),
        new("restart", "\"never\" | \"on-failure\" | \"always\"", "never",
            "What to do when it ends."),
    ];

    /// <summary>Fields of one entry in <c>services</c>.</summary>
    public static readonly IReadOnlyList<ConfigField> ServiceFields =
    [
        new("type", "string", "container",
            $"One of: {string.Join(", ", ServiceKind.Known.Keys)}."),
        new("image", "string", "the type's own image",
            "Override the image. Required when type is 'container'."),
        new("port", "number", "the type's own port",
            "Override the port. Required when type is 'container'."),
        new("user", "string", "the type's own convention",
            "The account to connect as."),
        new("database", "string", "the service name",
            "The database to create."),
        new("password", "string", "generated per session",
            "A literal password. Only set this when the data must outlive the session."),
        new("persist", "bool", "false",
            "Keep the service instance when the session ends, so its data survives. " +
            "Requires an explicit password."),
        new("env", "object of string", "{}",
            "Extra environment for the service instance."),
    ];

    /// <summary>The reference as text, for a terminal and for a prompt.</summary>
    public static string Render()
    {
        var text = new StringBuilder();

        text.AppendLine("# .envmux.json");
        text.AppendLine();
        text.AppendLine("Every field is optional, and so is the file. Any field not listed here is");
        text.AppendLine("rejected — envmux does not ignore what it does not recognise.");
        text.AppendLine();

        Table(text, "## Fields", Fields);
        text.AppendLine();
        Table(text, "## tasks.<name>", TaskFields);
        text.AppendLine();
        Table(text, "## services.<name>", ServiceFields);

        text.AppendLine();
        text.AppendLine("## Services expose themselves to the session as");
        text.AppendLine();
        text.AppendLine("  ConnectionStrings__<name>        what .NET configuration binds on its own");
        text.AppendLine("  services__<name>__tcp__0         Aspire's service discovery shape");
        text.AppendLine("  <NAME>_HOST _PORT _USER          for everything that is not .NET");
        text.AppendLine("  <NAME>_PASSWORD _DATABASE _URL");
        text.AppendLine();
        text.AppendLine("The generated password is the same string in all of them and the same string");
        text.AppendLine("the service instance was started with. A service has an address and a name of");
        text.AppendLine("its own inside the host. From this machine, a client that speaks SOCKS5 reaches");
        text.AppendLine("it by that name through the session's proxy (the URL is in the log).");

        return text.ToString();

        static void Table(StringBuilder text, string heading, IReadOnlyList<ConfigField> fields)
        {
            text.AppendLine(heading);
            text.AppendLine();

            var width = fields.Max(f => f.Path.Length);
            foreach (var field in fields)
            {
                text.AppendLine($"  {field.Path.PadRight(width)}  {field.Type}");
                text.AppendLine($"  {new string(' ', width)}  default: {field.Default}");
                text.AppendLine($"  {new string(' ', width)}  {field.Description}");
                text.AppendLine();
            }
        }
    }
}
