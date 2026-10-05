using Envmux.Config;
using Envmux.Session;

namespace Envmux.Commands;

/// <summary>
/// Inspecting and checking <c>.envmux.json</c> without starting anything.
/// </summary>
/// <remarks>
/// These exist so that something writing the file — a person or an agent — can
/// find out whether it worked without launching a container. That loop is only
/// as good as the errors, which is why the loader rejects unknown fields rather
/// than ignoring them.
/// </remarks>
internal static partial class ConfigCommand
{
    public static async Task<int> RunAsync(string directory, string? subcommand)
    {
        return subcommand switch
        {
            null or "validate" => await ValidateAsync(directory).ConfigureAwait(false),
            "show" => Show(directory),
            "schema" => Schema(),
            _ => Unknown(subcommand),
        };
    }

    private static int Unknown(string subcommand)
    {
        Console.Error.WriteLine($"envmux: unknown config command '{subcommand}'");
        Console.Error.WriteLine("        try: validate, show, schema");
        return 2;
    }

    /// <summary>
    /// Parse and resolve the config, reporting exactly what is wrong.
    /// </summary>
    /// <remarks>
    /// Deliberately does not need a host or git. An agent checking its own work
    /// should not have to start an engine to find out it wrote a typo.
    /// </remarks>
    public static async Task<int> ValidateAsync(string directory)
    {
        var path = Path.Combine(directory, SessionConfig.FileName);

        if (!File.Exists(path))
        {
            // Not an error: no file is a valid session. Say so plainly, because
            // "not found" reads as a failure otherwise.
            Console.WriteLine($"no {SessionConfig.FileName} here — that is valid; envmux would use defaults");
            return 0;
        }

        try
        {
            var config = SessionConfig.Load(directory);
            var plan = SessionPlan.Resolve(config, directory, "validate");

            Console.WriteLine($"{SessionConfig.FileName} is valid");
            Console.WriteLine($"  project   {plan.Project}");
            Console.WriteLine($"  instance  {plan.InstanceName} at {plan.Hostname}");
            Console.WriteLine($"  portal    {plan.Port}");

            Console.WriteLine(plan.Routes.Count == 0
                ? "  routes    none — nothing will be reachable in a browser"
                : $"  routes    {string.Join(", ", plan.Routes.Select(r =>
                    r.PinnedBy is { } task ? $"{r.Name}:{r.Port} (url from '{task}')" : $"{r.Name}:{r.Port}"))}");

            if (plan.Services.Count > 0)
            {
                Console.WriteLine(
                    $"  services  {string.Join(", ", plan.Services.Select(s => $"{s.Name}({s.Type})"))}");
            }

            if (plan.Tasks.Count > 0)
            {
                Console.WriteLine($"  tasks     {string.Join(", ", plan.Tasks.Select(t => t.Name))}");
            }

            if (plan.Tools.Count > 0)
            {
                Console.WriteLine($"  tools     {string.Join(", ", plan.Tools.Keys)}");
            }

            // Which env files were actually found. A missing one is skipped by
            // design — the config describes a project, and a machine where it
            // has not been set up yet should hear that from whatever needed the
            // value. But a typo in the name is indistinguishable from that, and
            // this is the command somebody runs to find out what is wrong before
            // running anything, so it says which is which.
            if (EnvFiles(directory, config) is { Count: > 0 } files)
            {
                Console.WriteLine($"  envFile   {string.Join(", ", files)}");
            }

            foreach (var warning in Warnings(plan))
            {
                Console.WriteLine($"  warning   {warning}");
            }

            await Task.CompletedTask.ConfigureAwait(false);
            return 0;
        }
        catch (ConfigException e)
        {
            Console.Error.WriteLine($"{SessionConfig.FileName} is not valid");
            Console.Error.WriteLine($"  {e.Message}");
            return 2;
        }
    }

    /// <summary>
    /// Things that parse but are probably not what was meant.
    /// </summary>
    /// <remarks>
    /// Warnings, not errors: each of these is legal and occasionally correct.
    /// They are here because they are the mistakes that produce a session which
    /// starts and then does nothing useful, which is harder to diagnose than a
    /// session that refuses to start.
    /// </remarks>
    /// <summary>
    /// Each declared env file, said with whether it is there and how much it holds.
    /// </summary>
    /// <remarks>
    /// Not a warning. A file that is absent is a fact about this machine, and
    /// naming it is the difference between "not set up here yet" and "spelt
    /// wrong" — which look identical from anywhere else, and one of which
    /// silently supplies nothing.
    /// </remarks>
    /// <param name="directory">The project directory the paths are relative to.</param>
    /// <param name="config">The declaration.</param>
    private static List<string> EnvFiles(string directory, SessionConfig config)
    {
        var said = new List<string>();

        foreach (var relative in config.EnvFile?.Arguments ?? [])
        {
            var path = Path.IsPathRooted(relative) ? relative : Path.Combine(directory, relative);

            said.Add(File.Exists(path)
                ? $"{relative} ({DotEnv.Read(path).Count.ToString(System.Globalization.CultureInfo.InvariantCulture)} value(s))"
                : $"{relative} (not on this machine)");
        }

        return said;
    }

    private static IEnumerable<string> Warnings(SessionPlan plan)
    {
        if (plan.Routes.Count == 0 && plan.Services.Count > 0)
        {
            yield return "services are declared but no routes — nothing will be reachable in a browser";
        }

        foreach (var route in plan.Routes.Where(r => r.Port < 1024))
        {
            yield return
                $"route '{route.Name}' is on port {route.Port}, which needs privileges most images do not " +
                "give a non-root user";
        }

        foreach (var task in plan.Tasks.Where(t => Backgrounds(t.Display)))
        {
            yield return
                $"task '{task.Name}' looks like it backgrounds something — it does not need to. " +
                "envmux holds the task open and shows its output; a task that backgrounds itself " +
                "hides that output and exits immediately";
        }

        foreach (var task in plan.Tasks.Where(t => t.Kind == TaskKind.Once && t.ReadyPort is null && t.Restart == RestartPolicy.Always))
        {
            yield return $"task '{task.Name}' is 'once' and restarts always — it will run over and over";
        }

        foreach (var task in plan.Tasks.Where(t => t.Restart == RestartPolicy.Always))
        {
            yield return
                $"task '{task.Name}' restarts always — one that fails immediately will keep doing so all session";
        }

        // Only when there is no golden snapshot to copy from, since that is the
        // path this image is a fallback for.
        if (plan.Image.EndsWith("/latest", StringComparison.Ordinal))
        {
            yield return
                $"image '{plan.Image}' is unpinned — a moving alias makes sessions differ over time";
        }

        foreach (var service in plan.Services.Where(s => s.Persist))
        {
            yield return $"service '{service.Name}' persists — its volume outlives the session and prune will not take it";
        }
    }

    /// <summary>
    /// Whether a command looks like it puts something in the background.
    /// </summary>
    /// <remarks>
    /// A lone <c>&amp;</c>, which is the shell's background operator — and
    /// deliberately not <c>&amp;&amp;</c>, which is the most ordinary thing in
    /// a command line and was matched by the first version of this. A warning
    /// that fires on <c>npm ci &amp;&amp; npm run build</c> is a warning people
    /// learn to ignore.
    /// </remarks>
    internal static bool Backgrounds(string command) =>
        Background().IsMatch(command) || command.Contains("nohup", StringComparison.Ordinal);

    [System.Text.RegularExpressions.GeneratedRegex(@"(?<!&)&(?!&)")]
    private static partial System.Text.RegularExpressions.Regex Background();

    /// <summary>The resolved plan, with defaults applied.</summary>
    private static int Show(string directory)
    {
        var plan = SessionPlan.Resolve(SessionConfig.Load(directory), directory, "show");

        Console.WriteLine($"project    {plan.Project}");
        Console.WriteLine($"image      {plan.Image}");
        Console.WriteLine($"instance   {plan.InstanceName}");
        Console.WriteLine($"hostname   {plan.Hostname}  (inside the host, and ssh's alias)");
        Console.WriteLine($"workdir    {plan.Workdir}");
        Console.WriteLine($"shell      {plan.Shell}");
        Console.WriteLine($"domain     {plan.Domain}");
        Console.WriteLine($"branch     {plan.Branch}  (from {plan.Base})");
        Console.WriteLine(plan.Portal.Enabled
            ? $"portal     {Portal.PortalPlan.Loopback}:{plan.Port}" +
              $"{(plan.Portal.WantsToken ? "" : "  (no token)")}"
            : "portal     off");

        foreach (var route in plan.Routes)
        {
            // What the route is before anything has run. Once the task has
            // printed its URL the pane shows that instead, so say here that it
            // will.
            var pinned = route.PinnedBy is { } task ? $"  (the URL task '{task}' prints)" : "";
            Console.WriteLine($"route      {route.Name,-12} {route.Port,5}  {route.Url}{pinned}");
        }

        foreach (var task in plan.Tasks)
        {
            Console.WriteLine($"task       {task.Name,-12} {task.Display}");
        }

        foreach (var service in plan.Services)
        {
            Console.WriteLine($"service    {service.Name,-12} {service.Type,-10} {service.Image} → {service.Host}:{service.Port}");
        }

        // Names only. `envmux --dry-run` shows the values, and a resolved-config
        // dump is the sort of thing that ends up pasted into an issue.
        foreach (var key in plan.Env.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            Console.WriteLine($"env        {key}");
        }

        return 0;
    }

    private static int Schema()
    {
        Console.WriteLine(ConfigReference.Render());
        return 0;
    }
}
