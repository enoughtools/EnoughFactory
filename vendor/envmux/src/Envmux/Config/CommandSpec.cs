using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// A command written either as a string or as an argument list.
/// </summary>
/// <remarks>
/// <para>
/// The same two forms Docker and Compose use, and for the same reason. A string
/// is shell form — <c>"npm run dev"</c> means "hand this to a shell", so
/// pipelines, <c>&amp;&amp;</c> and variable expansion all work. An array is exec
/// form — <c>["npm", "run", "dev"]</c> — where nothing is interpreted and an
/// argument may contain spaces.
/// </para>
/// <para>
/// Which one was written matters and is kept, rather than being normalised away:
/// splitting a string on whitespace would quietly break every command with a
/// quoted argument in it, and wrapping an array in a shell would quietly undo
/// the reason somebody chose the array.
/// </para>
/// </remarks>
[JsonConverter(typeof(CommandSpecConverter))]
internal sealed record CommandSpec
{
    /// <summary>Shell form: the one line, verbatim. Exec form: the arguments.</summary>
    public required IReadOnlyList<string> Arguments { get; init; }

    /// <summary>Whether it was written as a string, and so wants a shell.</summary>
    public required bool IsShell { get; init; }

    /// <summary>An explicit empty value: <c>""</c> or <c>[]</c>.</summary>
    public bool IsEmpty => Arguments.Count == 0;

    public static CommandSpec Shell(string line) => new() { Arguments = [line], IsShell = true };

    public static CommandSpec Exec(params string[] arguments) => new() { Arguments = arguments, IsShell = false };

    /// <summary>How it reads back, for <c>--dry-run</c> and the reports.</summary>
    public override string ToString() =>
        IsShell ? Arguments.Count == 0 ? "" : Arguments[0] : string.Join(' ', Arguments);
}

/// <summary>Reads <c>"npm run dev"</c> and <c>["npm", "run", "dev"]</c> alike.</summary>
internal sealed class CommandSpecConverter : JsonConverter<CommandSpec>
{
    public override CommandSpec? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            var line = reader.GetString() ?? "";
            return line.Length == 0
                ? new CommandSpec { Arguments = [], IsShell = true }
                : CommandSpec.Shell(line);
        }

        if (reader.TokenType != JsonTokenType.StartArray)
        {
            throw new JsonException("a command is a string like \"npm run dev\", or a list like [\"npm\", \"run\", \"dev\"]");
        }

        var arguments = new List<string>();
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.String)
            {
                throw new JsonException("a command written as a list holds strings");
            }

            arguments.Add(reader.GetString() ?? "");
        }

        return new CommandSpec { Arguments = arguments, IsShell = false };
    }

    public override void Write(Utf8JsonWriter writer, CommandSpec value, JsonSerializerOptions options)
    {
        if (value.IsShell)
        {
            writer.WriteStringValue(value.Arguments.Count == 0 ? "" : value.Arguments[0]);
            return;
        }

        writer.WriteStartArray();
        foreach (var argument in value.Arguments)
        {
            writer.WriteStringValue(argument);
        }

        writer.WriteEndArray();
    }
}
