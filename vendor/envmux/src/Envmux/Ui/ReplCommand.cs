using System.Globalization;

namespace Envmux.Ui;

/// <summary>What a typed command asks for.</summary>
internal enum ReplVerb
{
    /// <summary>Nothing was typed.</summary>
    Nothing,

    /// <summary>What was typed is not a command.</summary>
    Unknown,

    Help,
    Quit,

    /// <summary>
    /// Hand the whole terminal to a shell until it exits.
    /// </summary>
    /// <remarks>
    /// Two spellings of it, because both are in people's fingers: <c>/shell</c>
    /// used to open a tab and <c>/attach</c> used to give the terminal away,
    /// and with no tabs to open they are the same act.
    /// </remarks>
    Shell,

    /// <summary>Attach an editor to the instance.</summary>
    Code,

    /// <summary>Open a route in a browser.</summary>
    Open,

    /// <summary>Open the portal — this session, in a browser tab.</summary>
    Portal,

    /// <summary>Open a browser whose localhost is the instance.</summary>
    Browser,

    /// <summary>Switch to a named layout, or list them.</summary>
    Screen,

    /// <summary>Start, stop or restart a task.</summary>
    Task,

    /// <summary>Restart the tasks from the config on disk.</summary>
    Restart,

    /// <summary>Say what the session is, in the log.</summary>
    Status,
}

/// <summary>A parsed command line.</summary>
/// <param name="Verb">What was asked for.</param>
/// <param name="Arguments">Everything after the verb.</param>
/// <param name="Typed">What was typed, for an error message that quotes it.</param>
internal sealed record ReplCommand(ReplVerb Verb, IReadOnlyList<string> Arguments, string Typed)
{
    /// <summary>The first argument, or null.</summary>
    public string? Argument => Arguments.Count > 0 ? Arguments[0] : null;

    /// <summary>The rest, joined back up — for an argument with spaces in it.</summary>
    public string Rest => string.Join(' ', Arguments);
}

/// <summary>
/// The command line, and what can be typed into it.
/// </summary>
/// <remarks>
/// <para>
/// Slash commands, because that is the vocabulary anybody arriving at this has
/// already learned somewhere else this decade. They are the way to reach the
/// things a key would be a poor fit for — anything that takes an argument, and
/// anything rare enough that a key spent on it would be a key wasted.
/// </para>
/// <para>
/// Parsing is here and doing is elsewhere, so what <c>/task restart web</c>
/// means can be tested without a container to restart anything in.
/// </para>
/// </remarks>
internal static class Repl
{
    /// <summary>Every command, and what it is for.</summary>
    /// <remarks>
    /// One table, read by the parser, by the help, and by completion. A command
    /// that works but is not listed is a command nobody finds.
    /// </remarks>
    public static readonly IReadOnlyList<(string Name, ReplVerb Verb, string Usage, string What)> Commands =
    [
        ("shell", ReplVerb.Shell, "/shell", "hand the terminal to a latched shell in the instance until it exits"),
        ("attach", ReplVerb.Shell, "/attach", "the same thing, by the other name"),
        ("code", ReplVerb.Code, "/code", "attach VS Code to this session's instance (a dev container by default; editor.attach)"),
        ("open", ReplVerb.Open, "/open [route]", "open a route in a browser; the selected one by default"),
        ("portal", ReplVerb.Portal, "/portal", "open this session in a browser; the link goes in the log either way"),
        ("browser", ReplVerb.Browser, "/browser [chrome|firefox|edge] [route|url]", "open a browser whose localhost is the instance, at a route or URL; browser.open by default"),
        ("screen", ReplVerb.Screen, "/screen [name]", "swap the layout: dashboard or log"),
        ("task", ReplVerb.Task, "/task <start|stop|restart> <name>", "act on a task"),
        ("restart", ReplVerb.Restart, "/restart", "restart the tasks from .envmux.json as it is now"),
        ("status", ReplVerb.Status, "/status", "put what this session is into the log"),
        ("help", ReplVerb.Help, "/help", "this"),
        ("quit", ReplVerb.Quit, "/quit", "end the session"),
    ];

    /// <summary>The names, for completion and for the error message.</summary>
    public static IEnumerable<string> Names => Commands.Select(c => "/" + c.Name);

    /// <summary>
    /// Read a line.
    /// </summary>
    /// <remarks>
    /// The leading slash is optional. Somebody who has just pressed a key to
    /// reach a command line has already said they want a command, and making
    /// them type a slash to prove it is a toll rather than a syntax.
    /// </remarks>
    public static ReplCommand Parse(string? line)
    {
        var typed = (line ?? "").Trim();

        if (typed.Length == 0)
        {
            return new ReplCommand(ReplVerb.Nothing, [], typed);
        }

        var words = typed.TrimStart('/', ':')
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (words.Length == 0)
        {
            return new ReplCommand(ReplVerb.Nothing, [], typed);
        }

        var name = words[0].ToLowerInvariant();
        var arguments = words[1..];

        // Exact first, then unambiguous prefix. `/sc` is /screen because
        // nothing else starts that way; `/s` is not, because three do.
        var verb = Commands.FirstOrDefault(c => c.Name.Equals(name, StringComparison.Ordinal)).Verb;

        if (verb == ReplVerb.Nothing)
        {
            var matches = Commands
                .Where(c => c.Name.StartsWith(name, StringComparison.Ordinal))
                .ToList();

            verb = matches.Count == 1 ? matches[0].Verb : ReplVerb.Unknown;
        }

        return new ReplCommand(verb, arguments, typed);
    }

    /// <summary>The help, as the lines it is printed on.</summary>
    public static IEnumerable<string> Help() =>
        Commands.Select(c => $"  {c.Usage,-36} {c.What}");
}
