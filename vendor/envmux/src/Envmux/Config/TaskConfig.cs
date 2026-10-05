using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>Whether a task is expected to finish.</summary>
[JsonConverter(typeof(TaskKindConverter))]
internal enum TaskKind
{
    /// <summary>It keeps running: a dev server, a watcher, a worker. The default.</summary>
    Ongoing,

    /// <summary>It is expected to finish, and to exit zero: a migration, an install.</summary>
    Once,
}

/// <summary>Reads <c>"ongoing"</c> and <c>"once"</c>.</summary>
internal sealed class TaskKindConverter : JsonConverter<TaskKind>
{
    public override TaskKind Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        Enum.TryParse<TaskKind>(reader.GetString(), true, out var kind)
            ? kind
            : throw new JsonException("a task's 'kind' is \"ongoing\" or \"once\"");

    public override void Write(Utf8JsonWriter writer, TaskKind value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToString().ToLowerInvariant());
}

/// <summary>What to do when a task's process ends.</summary>
[JsonConverter(typeof(RestartPolicyConverter))]
internal enum RestartPolicy
{
    /// <summary>Leave it stopped, and say so. The default.</summary>
    Never,

    /// <summary>Start it again if it exited non-zero.</summary>
    OnFailure,

    /// <summary>Start it again whatever it exited with.</summary>
    Always,
}

/// <summary>
/// A long-running command inside the session container.
/// </summary>
/// <remarks>
/// <para>
/// Services are external — their own containers, on the session's network.
/// Tasks are internal: they run in the container you work in, through
/// an exec, sharing its filesystem, its environment and its
/// loopback. A dev server, a bundler in watch mode, a queue worker.
/// </para>
/// <para>
/// Installs and migrations are tasks too, marked <c>"kind": "once"</c>. envmux
/// had a separate <c>setup</c> field for those and it earned its removal: it
/// could not depend on a service, its output had nowhere to go, and it left
/// people writing two things that were obviously one.
/// </para>
/// </remarks>
[JsonConverter(typeof(TaskConfigConverter))]
internal sealed record TaskConfig
{
    /// <summary>What to run. A string is given to a shell; a list is exec'd.</summary>
    public CommandSpec? Command { get; init; }

    /// <summary>Where to run it. Defaults to the session's <c>workdir</c>.</summary>
    public string? Workdir { get; init; }

    /// <summary>Extra environment, on top of the container's own.</summary>
    public Dictionary<string, string>? Env { get; init; }

    /// <summary>
    /// Whether envmux starts it. Defaults to true.
    /// </summary>
    /// <remarks>
    /// False declares a task without running it — it appears in the list, and
    /// starts when you ask it to. For the things you need occasionally and do
    /// not want competing for a port every session.
    /// </remarks>
    public bool? Autostart { get; init; }

    /// <summary>What to do when it ends. Defaults to <c>never</c>.</summary>
    public RestartPolicy? Restart { get; init; }

    /// <summary>Whether it is expected to finish. Defaults to <c>ongoing</c>.</summary>
    public TaskKind? Kind { get; init; }

    /// <summary>
    /// Tasks and services that have to be up first. A name, or a list of them.
    /// </summary>
    /// <remarks>
    /// Both, deliberately: a migration depends on the database being able to
    /// take a connection, and the web server depends on the migration having
    /// finished. Splitting those into two different fields would be describing
    /// envmux's internal categories rather than the dependency the person has.
    /// </remarks>
    public IReadOnlyList<string>? DependsOn { get; init; }

    /// <summary>
    /// The port that, once it is accepting, means this task is up.
    /// </summary>
    /// <remarks>
    /// Only meaningful on an ongoing task, and only worth setting if something
    /// depends on it. Without it, "up" means the command was launched — which
    /// says nothing about whether it is answering.
    /// </remarks>
    public int? Ready { get; init; }

    /// <summary>
    /// A pattern that finds this task's URL in its own output.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A route is a port on the instance's own address, and for most servers
    /// that is the whole address. It is not for a server whose URL carries a
    /// secret it made up on the way in — .NET Aspire's dashboard is the
    /// canonical one, printing <c>Login to the dashboard at
    /// https://localhost:17178/login?t=8c4f…</c> on every start. The port alone
    /// gets you a login page asking for the token that was on that line.
    /// </para>
    /// <para>
    /// So a task can say where in its output its URL is. A .NET regular
    /// expression, matched against each line as it arrives; the first capture
    /// group is the URL, or the whole match when there is none. The first line
    /// that matches wins, until the task restarts and prints a new one. The
    /// host part is then rewritten to <c>localhost</c> — the server may have
    /// printed <c>0.0.0.0</c> or its own name, and in the session's browser only
    /// <c>localhost</c> is the instance — and the port, path and query are kept
    /// exactly as printed, because the
    /// query is where the token is.
    /// </para>
    /// <para>
    /// Called <c>url</c> rather than <c>urlPattern</c> or <c>listen</c> for the
    /// same reason <c>ready</c> is not <c>readyPort</c>: a field is named for
    /// what it means to the person writing it — "this task's URL is in its
    /// output" — not for the mechanism envmux uses to get it. <c>listen</c> was
    /// rejected because on a page about ports it reads as binding a socket.
    /// </para>
    /// </remarks>
    public string? Url { get; init; }
}

/// <summary>
/// Reads the short and long forms of a <c>tasks</c> entry.
/// </summary>
/// <remarks>
/// <c>"web": "npm run dev"</c> is what almost every task is, so it is the form
/// that reads well. The object form exists for the ones that need a directory,
/// an environment, or a restart policy.
/// </remarks>
internal sealed class TaskConfigConverter : JsonConverter<TaskConfig>
{
    public override TaskConfig? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType is JsonTokenType.String or JsonTokenType.StartArray)
        {
            return new TaskConfig
            {
                Command = new CommandSpecConverter().Read(ref reader, typeof(CommandSpec), options),
            };
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                "a task is a command like \"npm run dev\", or an object with a \"command\" in it");
        }

        CommandSpec? command = null;
        string? workdir = null;
        Dictionary<string, string>? env = null;
        bool? autostart = null;
        RestartPolicy? restart = null;
        TaskKind? kind = null;
        List<string>? dependsOn = null;
        int? ready = null;
        string? url = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var property = reader.GetString();
            reader.Read();

            if (Is(property, "command"))
            {
                command = new CommandSpecConverter().Read(ref reader, typeof(CommandSpec), options);
            }
            else if (Is(property, "workdir"))
            {
                workdir = reader.GetString();
            }
            else if (Is(property, "env"))
            {
                env = ReadEnvironment(ref reader);
            }
            else if (Is(property, "autostart"))
            {
                autostart = reader.TokenType == JsonTokenType.True;
            }
            else if (Is(property, "restart"))
            {
                restart = new RestartPolicyConverter().Read(ref reader, typeof(RestartPolicy), options);
            }
            else if (Is(property, "kind"))
            {
                kind = new TaskKindConverter().Read(ref reader, typeof(TaskKind), options);
            }
            else if (Is(property, "dependsOn"))
            {
                dependsOn = ReadNames(ref reader);
            }
            else if (Is(property, "ready"))
            {
                ready = reader.GetInt32();
            }
            else if (Is(property, "url"))
            {
                url = reader.TokenType == JsonTokenType.String
                    ? reader.GetString()
                    : throw new JsonException(
                        "a task's 'url' is a pattern that finds its URL in its output, like " +
                        "\"Login to the dashboard at (https://\\\\S+)\"");
            }
            else
            {
                // Unlike the top level, which rejects what it does not know, a
                // task is read by hand and a Skip here would swallow typos. Say
                // so instead.
                throw new JsonException(
                    $"'{property}' is not part of a task. It takes " +
                    "command, workdir, env, autostart, restart, kind, dependsOn, ready, url.");
            }
        }

        return new TaskConfig
        {
            Command = command,
            Workdir = workdir,
            Env = env,
            Autostart = autostart,
            Restart = restart,
            Kind = kind,
            DependsOn = dependsOn,
            Ready = ready,
            Url = url,
        };

        static bool Is(string? property, string name) =>
            string.Equals(property, name, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Reads <c>"db"</c> and <c>["db", "install"]</c> alike.</summary>
    private static List<string> ReadNames(ref Utf8JsonReader reader)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            return [reader.GetString() ?? ""];
        }

        if (reader.TokenType != JsonTokenType.StartArray)
        {
            throw new JsonException("'dependsOn' is a name like \"db\", or a list like [\"db\", \"install\"]");
        }

        var names = new List<string>();
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.String)
            {
                throw new JsonException("'dependsOn' holds the names of tasks and services");
            }

            names.Add(reader.GetString() ?? "");
        }

        return names;
    }

    private static Dictionary<string, string> ReadEnvironment(ref Utf8JsonReader reader)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("a task's 'env' is an object of name to value");
        }

        var env = new Dictionary<string, string>(StringComparer.Ordinal);

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var key = reader.GetString() ?? "";
            reader.Read();
            env[key] = reader.GetString() ?? "";
        }

        return env;
    }

    public override void Write(Utf8JsonWriter writer, TaskConfig value, JsonSerializerOptions options)
    {
        // The short form when there is nothing else to say, so a config written
        // out reads like one written by hand.
        if (value is
            {
                Workdir: null, Env: null, Autostart: null, Restart: null,
                Kind: null, DependsOn: null, Ready: null, Url: null, Command: { } only,
            })
        {
            new CommandSpecConverter().Write(writer, only, options);
            return;
        }

        writer.WriteStartObject();

        if (value.Command is { } command)
        {
            writer.WritePropertyName("command");
            new CommandSpecConverter().Write(writer, command, options);
        }

        if (value.Workdir is { } workdir)
        {
            writer.WriteString("workdir", workdir);
        }

        if (value.Env is { } env)
        {
            writer.WriteStartObject("env");
            foreach (var (key, item) in env)
            {
                writer.WriteString(key, item);
            }

            writer.WriteEndObject();
        }

        if (value.Autostart is { } autostart)
        {
            writer.WriteBoolean("autostart", autostart);
        }

        if (value.Restart is { } restart)
        {
            writer.WritePropertyName("restart");
            new RestartPolicyConverter().Write(writer, restart, options);
        }

        if (value.Kind is { } kind)
        {
            writer.WritePropertyName("kind");
            new TaskKindConverter().Write(writer, kind, options);
        }

        if (value.DependsOn is { } dependsOn)
        {
            writer.WriteStartArray("dependsOn");
            foreach (var name in dependsOn)
            {
                writer.WriteStringValue(name);
            }

            writer.WriteEndArray();
        }

        if (value.Ready is { } ready)
        {
            writer.WriteNumber("ready", ready);
        }

        if (value.Url is { } url)
        {
            writer.WriteString("url", url);
        }

        writer.WriteEndObject();
    }
}

/// <summary>Reads <c>"never"</c>, <c>"on-failure"</c> and <c>"always"</c>.</summary>
internal sealed class RestartPolicyConverter : JsonConverter<RestartPolicy>
{
    public override RestartPolicy Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetString()?.Replace("-", "", StringComparison.Ordinal) is { } written &&
        Enum.TryParse<RestartPolicy>(written, true, out var policy)
            ? policy
            : throw new JsonException("'restart' must be \"never\", \"on-failure\", or \"always\"");

    public override void Write(Utf8JsonWriter writer, RestartPolicy value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value == RestartPolicy.OnFailure ? "on-failure" : value.ToString().ToLowerInvariant());
}
