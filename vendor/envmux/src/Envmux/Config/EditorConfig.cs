using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Config;

/// <summary>
/// How the editor key opens the session.
/// </summary>
/// <remarks>
/// Written as a path — <c>"editor": "/usr/bin/code"</c> — or as an object when
/// there is more to say. Absent, envmux finds an editor and opens the session's
/// working directory in the window that is already there.
/// </remarks>
[JsonConverter(typeof(EditorConfigConverter))]
internal sealed record EditorConfig
{
    /// <summary>
    /// The editor to run. Found on this machine when absent.
    /// </summary>
    /// <remarks>
    /// Set-but-missing is an error rather than a fallthrough: somebody who named
    /// an editor does not want a different one opening instead.
    /// </remarks>
    public string? Path { get; init; }

    /// <summary>Open a new window rather than reusing the one in front of you.</summary>
    public bool? NewWindow { get; init; }

    /// <summary>The folder to open inside the container. Defaults to <c>workdir</c>.</summary>
    public string? Folder { get; init; }

    /// <summary>
    /// How the editor reaches the instance: <c>"devcontainer"</c> or <c>"ssh"</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>devcontainer</c> (the default) attaches through the Docker-compatible
    /// endpoint: the window is a Dev Containers window, and the endpoint starts
    /// itself on demand and holds open with a lease (<see cref="EditorAttach"/>).
    /// It needs VS Code's <c>dev.containers.dockerPath</c> pointed at the
    /// endpoint — the one thing envmux cannot set for you.
    /// </para>
    /// <para>
    /// <c>ssh</c> points VS Code at the instance's hostname over SSH instead —
    /// a Remote-SSH window, needing nothing else running. It is the fallback for
    /// where a plain SSH remote is wanted.
    /// </para>
    /// </remarks>
    public string? Attach { get; init; }

    /// <summary>
    /// Whether this is the Dev Containers attach rather than the SSH one.
    /// </summary>
    /// <remarks>
    /// Dev Containers is the default on Windows and macOS, where the endpoint
    /// has a native transport. An explicit SSH choice always opts out.
    /// </remarks>
    public bool IsDevContainer => Attach is null
        ? OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
        : string.Equals(Attach, EditorAttach.DevContainer, StringComparison.Ordinal);
}

/// <summary>The two ways the editor attaches.</summary>
internal static class EditorAttach
{
    public const string Ssh = "ssh";

    public const string DevContainer = "devcontainer";

    /// <summary>Check a value, returning it normalised, or throw with the choices.</summary>
    public static string Validate(string value) =>
        value.Trim().ToLowerInvariant() switch
        {
            Ssh => Ssh,
            DevContainer => DevContainer,
            var other => throw new JsonException(
                $"'attach' is \"{Ssh}\" or \"{DevContainer}\", not \"{other}\""),
        };
}

/// <summary>Reads both the short and long forms of <c>editor</c>.</summary>
internal sealed class EditorConfigConverter : JsonConverter<EditorConfig>
{
    public override EditorConfig? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            return new EditorConfig { Path = reader.GetString() };
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                "'editor' is a path like \"code\", or an object with path, newWindow, folder");
        }

        string? path = null;
        bool? newWindow = null;
        string? folder = null;
        string? attach = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var property = reader.GetString();
            reader.Read();

            if (Is(property, "path"))
            {
                path = reader.GetString();
            }
            else if (Is(property, "newWindow"))
            {
                newWindow = reader.TokenType == JsonTokenType.True;
            }
            else if (Is(property, "folder"))
            {
                folder = reader.GetString();
            }
            else if (Is(property, "attach"))
            {
                attach = EditorAttach.Validate(reader.GetString() ?? "");
            }
            else
            {
                throw new JsonException(
                    $"'{property}' is not part of 'editor'. It takes path, newWindow, folder, attach.");
            }
        }

        return new EditorConfig { Path = path, NewWindow = newWindow, Folder = folder, Attach = attach };

        static bool Is(string? property, string name) =>
            string.Equals(property, name, StringComparison.OrdinalIgnoreCase);
    }

    public override void Write(Utf8JsonWriter writer, EditorConfig value, JsonSerializerOptions options)
    {
        if (value is { NewWindow: null, Folder: null, Attach: null, Path: { } only })
        {
            writer.WriteStringValue(only);
            return;
        }

        writer.WriteStartObject();

        if (value.Path is { } path)
        {
            writer.WriteString("path", path);
        }

        if (value.NewWindow is { } newWindow)
        {
            writer.WriteBoolean("newWindow", newWindow);
        }

        if (value.Folder is { } folder)
        {
            writer.WriteString("folder", folder);
        }

        if (value.Attach is { } attach)
        {
            writer.WriteString("attach", attach);
        }

        writer.WriteEndObject();
    }
}
