using System.Text;

using Envmux.Config;
using Envmux.Editor;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The URI an editor is pointed at.
/// </summary>
/// <remarks>
/// This used to be a much longer file, guarding a format VS Code has never
/// documented: the attached-container link, whose reference vectors came from
/// reading what VS Code itself produces. It named a container on the local
/// engine, there is no local engine, and the ssh-remote form that replaced it
/// <em>is</em> documented — so what is left to pin is the encoding and the
/// refusal.
/// </remarks>
public class VsCodeUriTests
{
    [Fact]
    public void EnvmuxsOwnInstanceNamesAreValidSshTargets()
    {
        // The names this actually gets handed, which is the case that matters.
        var plan = SessionPlan.Resolve(new SessionConfig { Name = "my.proj" }, Path.GetTempPath(), "feat/login");

        Assert.Equal(
            $"envmux@{plan.Hostname}",
            VsCodeUri.NormalizeSshAuthority("envmux", plan.Hostname));
    }

    [Theory]
    [InlineData("envmux", "-leading-hyphen.envmux")]
    [InlineData("envmux", "has space.envmux")]
    [InlineData("has;semicolon", "host.envmux")]
    [InlineData("", "host.envmux")]
    public void HostileSshTargetsAreRejectedRatherThanEscaped(string user, string host)
    {
        // On Windows the editor is usually a .cmd, which is run through a
        // command interpreter, so a value carrying metacharacters would reach
        // one. The answer is rejection, not escaping.
        Assert.Throws<EditorException>(() => VsCodeUri.NormalizeSshAuthority(user, host));
    }

    [Fact]
    public void TheSshUriNamesTheHostAndThePath() =>
        Assert.Equal(
            "vscode-remote://ssh-remote+envmux@proj-sess.envmux/work",
            VsCodeUri.SshFolderUri("envmux", "proj-sess.envmux", "/work"));

    [Theory]
    [InlineData("/work/my project", "/work/my%20project")]
    [InlineData("/work/A-z0.9_~", "/work/A-z0.9_~")]
    [InlineData("/work/café", "/work/caf%C3%A9")]
    [InlineData("/", "/")]
    public void PathEncodingNeverTouchesTheSeparators(string path, string expected) =>
        Assert.Equal(expected, VsCodeUri.EncodePath(path));

    [Fact]
    public void TheRootFolderKeepsItsSingleSlash() =>
        Assert.EndsWith(
            "/", VsCodeUri.SshFolderUri("envmux", "proj-sess.envmux", "/"), StringComparison.Ordinal);

    [Fact]
    public void ARelativeFolderIsMadeAbsolute() =>
        Assert.Equal(
            VsCodeUri.SshFolderUri("envmux", "h.envmux", "/work"),
            VsCodeUri.SshFolderUri("envmux", "h.envmux", "work"));
}

public class EditorDiscoveryTests
{
    /// <summary>
    /// A fabricated machine: these files exist, nothing else does.
    /// </summary>
    /// <remarks>
    /// Separators are normalised on both sides. The cases worth testing are all
    /// about machines this one is not, and <c>Path.Combine</c> joins with a
    /// backslash when the test happens to run on Windows.
    /// </remarks>
    private static DiscoveryInputs Machine(
        string[] present,
        string? config = null,
        string? vsCodeBin = null,
        string[]? pathDirectories = null,
        string[]? wellKnown = null) => new()
        {
            ConfigPath = config,
            VsCodeBin = vsCodeBin,
            PathDirectories = pathDirectories ?? ["/bin"],
            Extensions = [],
            WellKnown = wellKnown ?? ["/usr/share/code/bin/code"],
            Exists = p => present.Select(Slashes).Contains(Slashes(p), StringComparer.Ordinal),
        };

    private static string Slashes(string path) => path.Replace('\\', '/');

    private static readonly string[] Everything =
        ["/opt/mine/editor", "/opt/env/editor", "/bin/code", "/usr/share/code/bin/code"];

    [Fact]
    public void ConfigBeatsEverything() =>
        Assert.Equal(
            "/opt/mine/editor",
            EditorDiscovery.Find(Machine(Everything, config: "/opt/mine/editor", vsCodeBin: "/opt/env/editor")).Path);

    [Fact]
    public void ThenTheEnvironmentVariable() =>
        Assert.Equal("/opt/env/editor", EditorDiscovery.Find(Machine(Everything, vsCodeBin: "/opt/env/editor")).Path);

    [Fact]
    public void ThenThePath() =>
        Assert.Equal("/bin/code", Slashes(EditorDiscovery.Find(Machine(Everything)).Path));

    [Fact]
    public void ThenTheWellKnownPlaces() =>
        Assert.Equal(
            "/usr/share/code/bin/code",
            EditorDiscovery.Find(Machine(Everything, pathDirectories: [])).Path);

    [Fact]
    public void StableBeatsInsidersAcrossTheWholePath()
    {
        // code-insiders sits in an earlier PATH entry; stable still wins,
        // because the search is name-major. Somebody with both installed meant
        // the stable one unless they said otherwise.
        var found = EditorDiscovery.Find(Machine(
            ["/early/code-insiders", "/late/code"],
            pathDirectories: ["/early", "/late"],
            wellKnown: []));

        Assert.Equal("/late/code", Slashes(found.Path));
    }

    [Fact]
    public void AConfiguredEditorThatIsMissingIsAnErrorNotAFallthrough()
    {
        // Launching a different editor than the one that was named would be a
        // silent surprise.
        var e = Assert.Throws<EditorException>(() =>
            EditorDiscovery.Find(Machine(["/bin/code"], config: "/opt/gone")));

        Assert.Contains("/opt/gone", e.Message, StringComparison.Ordinal);
        Assert.Contains("editor.path", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SameContractForTheEnvironmentVariable()
    {
        var e = Assert.Throws<EditorException>(() =>
            EditorDiscovery.Find(Machine(["/bin/code"], vsCodeBin: "/opt/gone")));

        Assert.Contains("VSCODE_BIN", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void FindingNothingListsEverythingTried()
    {
        var e = Assert.Throws<EditorException>(() => EditorDiscovery.Find(Machine([])));

        foreach (var name in EditorDiscovery.Names)
        {
            Assert.Contains(name, e.Message, StringComparison.Ordinal);
        }

        Assert.Contains("editor.path", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WindowsProbesCmdBeforeExe()
    {
        var found = EditorDiscovery.Find(new DiscoveryInputs
        {
            PathDirectories = [@"C:\bin"],
            Extensions = [".cmd", ".exe"],
            WellKnown = [],
            Exists = p => p == Path.Combine(@"C:\bin", "code.cmd"),
        });

        Assert.EndsWith("code.cmd", found.Path, StringComparison.Ordinal);
    }

    [Fact]
    public void CodiumComesWithAWarningAttached()
    {
        var found = EditorDiscovery.Find(Machine(["/bin/codium"], wellKnown: []));
        Assert.Contains("Remote-SSH", found.Hint!, StringComparison.Ordinal);
    }

    [Fact]
    public void SoDoesAFlatpak()
    {
        const string Flatpak = "/var/lib/flatpak/exports/bin/com.visualstudio.code";
        var found = EditorDiscovery.Find(Machine([Flatpak], pathDirectories: [], wellKnown: [Flatpak]));

        Assert.Contains("sandbox", found.Hint!, StringComparison.Ordinal);
    }

    [Fact]
    public void APlainInstallHasNothingToSayAboutItself() =>
        Assert.Null(EditorDiscovery.Find(Machine(["/bin/code"], wellKnown: [])).Hint);
}

public class EditorLaunchTests
{
    private const string Uri =
        "vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a222f74657374227d/work";

    [Fact]
    public void TheArgumentsAreFolderUriAndTheUriAndNothingElse()
    {
        // Its own element, never joined with '='. The URI carries
        // percent-encoding, and every round trip through something that
        // re-splits it is a chance to mangle that.
        Assert.Equal(["--folder-uri", Uri], new LaunchPlan("code", Uri, false, null).Arguments);
    }

    [Fact]
    public void ANewWindowIsAskedForFirst() =>
        Assert.Equal(
            ["--new-window", "--folder-uri", Uri],
            new LaunchPlan("code", Uri, true, null).Arguments);
}

public class EditorConfigTests
{
    private static SessionPlan Plan(string json) =>
        SessionPlan.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Path.Combine(Path.GetTempPath(), "myproj"),
            "amber-fox");

    [Fact]
    public void DefaultsToFindingOneAndReusingTheWindow()
    {
        var editor = Plan("{}").Editor;

        Assert.Null(editor.Path);
        Assert.Null(editor.NewWindow);
        Assert.Null(editor.Folder);
    }

    [Fact]
    public void TheShortFormIsAPath() =>
        Assert.Equal("/usr/bin/code", Plan("""{ "editor": "/usr/bin/code" }""").Editor.Path);

    [Fact]
    public void TheLongFormSaysMore()
    {
        var editor = Plan("""
            { "editor": { "path": "cursor", "newWindow": true, "folder": "/work/api" } }
            """).Editor;

        Assert.Equal("cursor", editor.Path);
        Assert.True(editor.NewWindow);
        Assert.Equal("/work/api", editor.Folder);
    }

    [Fact]
    public void RefusesAFieldEditorDoesNotHave()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "editor": { "path": "code", "window": "new" } }"""));

        Assert.Contains("window", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheFolderDefaultsToTheSessionNamedLinkNotTheWorkdir()
    {
        // The link, not /src: every session's workdir is the same path, and an
        // editor that opened it filed every session under the same name. The
        // plan resolves this once, and the `e` key, `envmux code` and the
        // portal all read the same property.
        var plan = Plan("""{ "workdir": "/src" }""");

        Assert.Equal("/myproj_amber-fox", plan.EditorFolder);
        Assert.Equal("/src", plan.Workdir);
    }

    [Fact]
    public void AFolderThatWasWrittenDownIsOpenedAsWritten()
    {
        // Even one under the workdir. Rewriting /src/api onto the link would
        // gain nothing — the window would still be called api — and would put a
        // path they never wrote in front of them.
        var plan = Plan("""{ "workdir": "/src", "editor": { "folder": "/src/api" } }""");

        Assert.Equal("/src/api", plan.EditorFolder);
    }

    [Fact]
    public void BothAttachFormsOpenTheLink()
    {
        var plan = Plan("""{ "editor": { "attach": "ssh" } }""");

        Assert.EndsWith(
            "/myproj_amber-fox",
            VsCodeUri.SshFolderUri("matt", plan.Hostname, plan.EditorFolder),
            StringComparison.Ordinal);
        Assert.EndsWith(
            "/myproj_amber-fox",
            DockerUri.AttachedContainerUri(plan.InstanceName, plan.EditorFolder),
            StringComparison.Ordinal);
    }

    [Fact]
    public void AttachIsUnsetByDefault()
    {
        Assert.Null(Plan("{}").Editor.Attach);
    }

    [Fact]
    public void TheDefaultAttachIsDevContainerWhereTheEndpointServes()
    {
        // Left unsaid, the attach is the Dev Containers one wherever there is an
        // endpoint to serve it — Windows and macOS — and SSH elsewhere.
        Assert.Equal(OperatingSystem.IsWindows() || OperatingSystem.IsMacOS(), Plan("{}").Editor.IsDevContainer);
    }

    [Fact]
    public void ExplicitSshOptsOut()
    {
        var editor = Plan("""{ "editor": { "attach": "ssh" } }""").Editor;

        Assert.Equal(EditorAttach.Ssh, editor.Attach);
        Assert.False(editor.IsDevContainer);
    }

    [Fact]
    public void ExplicitDevContainerForcesItEverywhere()
    {
        var editor = Plan("""{ "editor": { "attach": "devcontainer" } }""").Editor;

        Assert.Equal(EditorAttach.DevContainer, editor.Attach);
        Assert.True(editor.IsDevContainer);
    }

    [Fact]
    public void AttachRejectsAnythingElse()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "editor": { "attach": "tunnel" } }"""));

        Assert.Contains("tunnel", e.Message, StringComparison.Ordinal);
    }
}
