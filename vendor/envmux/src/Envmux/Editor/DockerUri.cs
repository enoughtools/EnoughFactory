using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Envmux.Editor;

/// <summary>
/// The <c>vscode-remote://dev-container+&lt;hex&gt;/…</c> URI that opens a
/// folder against the Docker endpoint.
/// </summary>
/// <remarks>
/// <para>
/// docs/vscode-remote.md §8.1. The authority is the hex of a JSON object naming
/// the host folder and, crucially, <c>localDocker: false</c> — which is what
/// tells the extension the daemon is remote and the workspace lives on the
/// target. The path after the authority is the folder inside the target,
/// <c>/workspaces/&lt;name&gt;</c> unless the devcontainer overrides it.
/// </para>
/// <para>
/// Undocumented and reverse-engineered (vscode-remote-release#5867), so it is
/// built in one place with the fields spelled exactly, the way the ssh-remote
/// form is in <see cref="VsCodeUri"/>. A wrong path inside the authority
/// decodes to <c>ENOPRO: No file system provider found</c> (§11.3).
/// </para>
/// </remarks>
internal static class DockerUri
{
    internal sealed record ConfigFile(
        [property: JsonPropertyName("$mid")] int Mid,
        [property: JsonPropertyName("fsPath")] string FsPath,
        [property: JsonPropertyName("path")] string Path,
        [property: JsonPropertyName("scheme")] string Scheme);

    internal sealed record Authority(
        [property: JsonPropertyName("hostPath")] string HostPath,
        [property: JsonPropertyName("localDocker")] bool LocalDocker,
        [property: JsonPropertyName("configFile")] ConfigFile ConfigFile);

    private static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = WireJsonContext.Default,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    /// <summary>
    /// The folder URI for a host path with a devcontainer config.
    /// </summary>
    /// <param name="hostPath">The folder as the client sees it, verbatim — the label the extension keys on.</param>
    /// <param name="configFilePath">The absolute path to its <c>devcontainer.json</c>.</param>
    /// <param name="workspaceFolder">The folder inside the target, or null for <c>/workspaces/&lt;name&gt;</c>.</param>
    public static string DevContainerFolderUri(string hostPath, string configFilePath, string? workspaceFolder)
    {
        // A vscode.Uri as it serialises: a lowercase drive in fsPath, forward
        // slashes with a leading "/" in path. On a non-Windows path both are
        // just the path.
        var fsPath = LowerDrive(configFilePath);
        var uriPath = "/" + fsPath.Replace('\\', '/').TrimStart('/');

        var authority = new Authority(
            hostPath,
            LocalDocker: false,
            new ConfigFile(1, fsPath, uriPath, "file"));

        var hex = Convert.ToHexStringLower(Encoding.UTF8.GetBytes(WireJson.Serialize(authority, Options)));

        var inside = string.IsNullOrEmpty(workspaceFolder)
            ? "/workspaces/" + FolderName(hostPath)
            : (workspaceFolder.StartsWith('/') ? workspaceFolder : "/" + workspaceFolder);

        return $"vscode-remote://dev-container+{hex}{VsCodeUri.EncodePath(inside)}";
    }

    /// <summary>
    /// The folder URI that attaches to an instance that is already running (§8.3).
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>attached-container+&lt;hex&gt;&lt;path&gt;</c>, where the hex is the
    /// UTF-8 of <c>{"containerName","settings"}</c>. Unlike the
    /// <c>dev-container</c> form this names an existing container rather than a
    /// workspace folder, so the extension inspects and attaches without creating
    /// or building anything — which is exactly what a live envmux session is.
    /// </para>
    /// <para>
    /// <b>The authority carries the docker host.</b> <c>settings.host</c> is set
    /// to the endpoint's <c>DOCKER_HOST</c>, and the extension turns it into
    /// <c>DOCKER_HOST</c> for every docker call — the "is Docker running"
    /// preflight included, which is what makes this need nothing in the user's
    /// <c>settings.json</c>: no <c>dev.containers.dockerPath</c>, no context, no
    /// wrapper. Verified: the preflight then reports <c>Server: envmux (Incus)</c>
    /// and never falls back to Docker Desktop. The one thing it does rely on is a
    /// real <c>docker</c> on <c>PATH</c>, which the extension needs regardless.
    /// </para>
    /// </remarks>
    /// <param name="containerName">The instance's name, which is what the extension inspects.</param>
    /// <param name="folder">The folder to open inside it.</param>
    /// <param name="dockerHost">The endpoint's <c>DOCKER_HOST</c>, baked into the authority; null omits it.</param>
    public static string AttachedContainerUri(string containerName, string folder, string? dockerHost = null)
    {
        object authority = string.IsNullOrEmpty(dockerHost)
            ? WireJson.Object(Options, ("containerName", containerName), ("settings", WireJson.Object(Options)))
            : WireJson.Object(Options, ("containerName", containerName), ("settings", WireJson.Object(Options, ("host", dockerHost))));

        var hex = Convert.ToHexStringLower(Encoding.UTF8.GetBytes(WireJson.Serialize(authority, Options)));
        var inside = folder.StartsWith('/') ? folder : "/" + folder;

        return $"vscode-remote://attached-container+{hex}{VsCodeUri.EncodePath(inside)}";
    }

    private static string LowerDrive(string path) =>
        path.Length >= 2 && char.IsAsciiLetter(path[0]) && path[1] == ':'
            ? char.ToLowerInvariant(path[0]) + path[1..]
            : path;

    private static string FolderName(string hostPath) =>
        Path.GetFileName(hostPath.Replace('\\', '/').TrimEnd('/')) is { Length: > 0 } name ? name : "workspace";
}
