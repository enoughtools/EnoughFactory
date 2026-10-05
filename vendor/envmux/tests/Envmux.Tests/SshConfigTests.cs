using Envmux.Commands;
using Envmux.Editor;
using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The block envmux writes into somebody else's <c>~/.ssh/config</c>.
/// </summary>
/// <remarks>
/// <para>
/// Two things are being guarded, and they pull in opposite directions. The block
/// has to actually take effect — ssh uses the first value it obtains for each
/// keyword, so a <c>Host *</c> already in the file beats anything appended after
/// it — and it has to leave the rest of the file exactly as it found it, because
/// this file decides what the machine connects to and with what.
/// </para>
/// <para>
/// And the zone is a value from two config files, one of which arrives with a
/// checkout. A hardcoded <c>.envmux</c> is a bug on a host whose zone is
/// something else; an unvalidated one is a way to append lines to an ssh config
/// from a repository.
/// </para>
/// </remarks>
public class SshConfigTests : IDisposable
{
    private const string Key = "/home/matt/.envmux/id_ed25519";
    private const string Known = "/home/matt/.envmux/known_hosts";
    private const string Relay = "\"/home/matt/.envmux/bin/envmux\" relay";

    public SshConfigTests() => CommandName.OverrideForTesting("envmux");

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        CommandName.OverrideForTesting(null);
    }

    private static string Block(params string[] zones) => SshConfig.Block(zones, Key, Known, Relay);

    /// <summary>
    /// The name is an alias, and the ProxyCommand is what makes it one.
    /// </summary>
    /// <remarks>
    /// Nothing on the workstation resolves <c>*.envmux</c> any more, so a block
    /// without this line is a Host entry for names ssh cannot reach. <c>%h</c>
    /// is the alias as typed, zone and all — the relay takes the instance off
    /// the front — and <c>%p</c> keeps a <c>Port</c> somebody adds honest.
    /// </remarks>
    [Fact]
    public void TheNameIsReachedThroughTheRelayNotResolved() =>
        Assert.Contains($"    ProxyCommand {Relay} %h %p\n", Block("envmux"), StringComparison.Ordinal);

    /// <summary>
    /// The relay is this executable by absolute path, quoted, and the runtime host gets its assembly.
    /// </summary>
    /// <remarks>
    /// ssh runs the ProxyCommand from an editor's helper process with whatever
    /// PATH that has, so the path has to be the whole of the answer. Run as
    /// <c>dotnet envmux.dll</c> the process is the runtime, and the runtime alone
    /// is a command that runs nothing of ours.
    /// </remarks>
    [Theory]
    [InlineData("C:\\Users\\Matt\\.envmux\\bin\\envmux.exe", null, "\"C:/Users/Matt/.envmux/bin/envmux.exe\" relay")]
    [InlineData("C:\\Users\\A B\\.envmux\\bin\\devenvmux.exe", "", "\"C:/Users/A B/.envmux/bin/devenvmux.exe\" relay")]
    [InlineData("/usr/local/bin/envmux", "/usr/local/lib/envmux/envmux.dll", "\"/usr/local/bin/envmux\" relay")]
    [InlineData(
        "C:\\Program Files\\dotnet\\dotnet.exe",
        "Z:\\envmux\\src\\Envmux\\bin\\Debug\\net10.0\\envmux.dll",
        "\"C:/Program Files/dotnet/dotnet.exe\" \"Z:/envmux/src/Envmux/bin/Debug/net10.0/envmux.dll\" relay")]
    [InlineData("/usr/share/dotnet/dotnet", "/src/envmux/envmux.dll", "\"/usr/share/dotnet/dotnet\" \"/src/envmux/envmux.dll\" relay")]
    [InlineData(null, null, "envmux relay")]
    public void TheRelayIsThisExecutableByAbsolutePath(string? process, string? assembly, string expected) =>
        Assert.Equal(expected, SshConfig.Relay(process, assembly));

    [Fact]
    public void TheBlockNamesTheKeyAndOffersNothingElse()
    {
        var block = Block("envmux");

        Assert.Contains($"IdentityFile {Key}", block, StringComparison.Ordinal);

        // Without this ssh walks whatever else is in ~/.ssh and can hit
        // MaxAuthTries before it ever reaches the key the session authorised.
        Assert.Contains("IdentitiesOnly yes", block, StringComparison.Ordinal);

        // A recreated session is a new machine on an old name. Its own file
        // keeps that churn out of the workstation's known_hosts.
        Assert.Contains($"UserKnownHostsFile {Known}", block, StringComparison.Ordinal);
        Assert.Contains("StrictHostKeyChecking accept-new", block, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryZoneIsOnOneHostLine() =>
        // One Host line rather than two blocks, so there is one place for these
        // four settings rather than two that can disagree.
        Assert.Contains("Host *.envmux *.lab.local", Block("envmux", "lab.local"), StringComparison.Ordinal);

    [Fact]
    public void TheZoneIsTheConfiguredOneAndNeverTheDefault()
    {
        // The zone is host.json's, and a repository may name one of its own. A
        // block that said *.envmux on a host whose zone is something else would
        // be a Host entry that matches nothing, and an editor that never
        // attaches on the one machine that was configured rather than defaulted.
        var block = Block("corp.dev");
        var host = block.Split('\n').Single(l => l.StartsWith("Host ", StringComparison.Ordinal));

        Assert.Equal("Host *.corp.dev", host);
        Assert.DoesNotContain("*.envmux", block, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("bad zone")]
    [InlineData("zone\nHost *\n    IdentityFile /tmp/theirs")]
    [InlineData("-leading-hyphen")]
    [InlineData("trailing-")]
    [InlineData("")]
    public void AZoneThatIsNotADnsNameNeverReachesTheFile(string zone)
    {
        // One of the two sources is a .envmux.json, which arrives with a
        // checkout. ssh config has no escaping to reach for, so this is a
        // refusal rather than a quoting problem.
        Assert.Empty(SshConfig.Normalize([zone]));
        Assert.Throws<SshConfigException>(() => Block(zone));
    }

    [Fact]
    public void ZonesAreLowercasedAndDeduplicatedInTheOrderTheyArrived() =>
        Assert.Equal(["envmux", "lab.local"], SshConfig.Normalize(["ENVMUX", ".envmux.", "lab.local", "envmux"]));

    [Fact]
    public void ABlockGoesAboveWhatIsAlreadyThere()
    {
        // ssh takes the first value it obtains for each keyword. Appended, this
        // block would work on a fresh workstation and quietly do nothing on one
        // that already has a Host * — which is the workstation more likely to
        // have someone waiting on it.
        const string Existing = "Host *\n    IdentitiesOnly no\n";
        var merged = SshConfig.Merge(Existing, Block("envmux"));

        Assert.StartsWith(SshConfig.Begin, merged, StringComparison.Ordinal);
        Assert.EndsWith(Existing, merged, StringComparison.Ordinal);
    }

    [Fact]
    public void EverythingOutsideTheMarkersSurvivesAnUpdateUntouched()
    {
        var before = SshConfig.Merge("Host github.com\n    User git\n", Block("envmux"));
        var after = SshConfig.Merge(before, Block("envmux", "lab.local"));

        Assert.Contains("Host *.envmux *.lab.local", after, StringComparison.Ordinal);

        // The one Host line changed and nothing else did — not the other entry,
        // and not the block's own count.
        Assert.Contains("Host github.com\n    User git\n", after, StringComparison.Ordinal);
        Assert.Equal(1, Count(after, SshConfig.Begin));
        Assert.Equal(1, Count(after, SshConfig.End));
    }

    [Fact]
    public void WritingTheSameBlockTwiceChangesNothing()
    {
        // What makes this safe to run from `envmux install` and again by hand:
        // the second run has to be a no-op down to the byte, or `envmux ssh`
        // becomes something people avoid running.
        var once = SshConfig.Merge("Host github.com\n    User git\n", Block("envmux"));

        Assert.Equal(once, SshConfig.Merge(once, Block("envmux")), StringComparer.Ordinal);
    }

    [Fact]
    public void ACrlfFileStaysACrlfFile()
    {
        // Otherwise one LF-terminated block in a CRLF config reads as corrupted
        // in an editor and diffs as though every line changed.
        var merged = SshConfig.Merge("Host github.com\r\n    User git\r\n", Block("envmux"));

        Assert.DoesNotContain("\n", merged.Replace("\r\n", "", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnclosedBlockIsRefusedRatherThanGuessedAt()
    {
        // Somebody deleted the end marker. Where the block stops is now a guess,
        // and a wrong guess takes their next Host entry with it.
        var opened = SshConfig.Begin + "\nHost *.envmux\n\nHost theirs\n    User them\n";

        Assert.Throws<SshConfigException>(() => SshConfig.Merge(opened, Block("envmux")));
    }

    [Fact]
    public void TheZonesInTheFileAreReadBackAndNeverNarrowed()
    {
        // A project whose .envmux.json names its own zone gets that zone into
        // the block. Running this from a different project must not take it
        // back out — that project's editor would stop attaching, from a command
        // run somewhere else entirely.
        var file = SshConfig.Merge("", Block("envmux", "lab.local"));

        Assert.Equal(["envmux", "lab.local"], SshConfig.Zones(file));
        Assert.Equal(["envmux", "lab.local"], SshConfig.Wanted(["envmux"], file));

        // And what is already written keeps its place, so running this from two
        // projects in turn does not reshuffle the Host line each time.
        Assert.Equal(["envmux", "lab.local", "corp.dev"], SshConfig.Wanted(["corp.dev", "envmux"], file));
    }

    [Fact]
    public void ThereAreNoZonesToReadBackOutOfAFileWithNoBlockInIt() =>
        Assert.Empty(SshConfig.Zones("Host *\n    IdentitiesOnly no\n"));

    [Theory]
    [InlineData("C:\\Users\\Matt\\.envmux\\id_ed25519", "id_ed25519")]
    public void PathsAreWrittenWithForwardSlashes(string path, string tail)
    {
        // OpenSSH on Windows treats a backslash in a config value as an escape
        // rather than a separator.
        var written = SshConfig.Tilde(path);

        Assert.DoesNotContain('\\', written);
        Assert.EndsWith(tail, written, StringComparison.Ordinal);
    }

    [Fact]
    public void APathUnderHomeIsWrittenAsATilde()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).Replace('\\', '/');

        Assert.Equal("~/.envmux/id_ed25519", SshConfig.Tilde($"{home}/.envmux/id_ed25519"));
    }

    [Fact]
    public void APathWithASpaceIsQuotedAndOneWithAQuoteIsRefused()
    {
        // C:/Users/Firstname Lastname is an ordinary Windows profile, and an
        // ssh config line that means two arguments.
        Assert.Equal("\"C:/Users/A B/.envmux/id_ed25519\"", SshConfig.Quote("C:/Users/A B/.envmux/id_ed25519"));
        Assert.Equal("C:/Users/AB/.envmux/id_ed25519", SshConfig.Quote("C:/Users/AB/.envmux/id_ed25519"));
        Assert.Throws<SshConfigException>(() => SshConfig.Quote("C:/Users/A\"B/id_ed25519"));
    }

    private static int Count(string text, string needle) =>
        text.Split(needle, StringSplitOptions.None).Length - 1;
}

/// <summary>
/// The same block, through the file on disk.
/// </summary>
/// <remarks>
/// Both the envmux directory and ssh's are moved for these, so nothing here can
/// reach the developer's own <c>~/.ssh/config</c> — which is the file the whole
/// class is about not damaging.
/// </remarks>
[Collection(HostHome.Name)]
public class SshConfigFileTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("envmux-ssh-home-").FullName;
    private readonly string _ssh = Directory.CreateTempSubdirectory("envmux-ssh-").FullName;
    private readonly string? _wasHome = Environment.GetEnvironmentVariable("ENVMUX_HOME");
    private readonly string? _wasSsh = Environment.GetEnvironmentVariable("ENVMUX_SSH_HOME");

    public SshConfigFileTests()
    {
        Environment.SetEnvironmentVariable("ENVMUX_HOME", _home);
        Environment.SetEnvironmentVariable("ENVMUX_SSH_HOME", _ssh);
        CommandName.OverrideForTesting("envmux");
    }

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        Environment.SetEnvironmentVariable("ENVMUX_HOME", _wasHome);
        Environment.SetEnvironmentVariable("ENVMUX_SSH_HOME", _wasSsh);
        CommandName.OverrideForTesting(null);

        foreach (var directory in new[] { _home, _ssh })
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
                // A leaked temp directory is not worth failing a test over.
            }
        }
    }

    [Fact]
    public void TheFileIsMadeWhenThereIsNoneAndLeftAloneWhenItIsAlreadyRight()
    {
        Assert.False(File.Exists(SshConfig.Location));

        var added = SshConfig.Apply(["envmux"]);
        Assert.Equal(SshConfigChange.Added, added.Change);

        var text = File.ReadAllText(SshConfig.Location);
        Assert.Contains("Host *.envmux", text, StringComparison.Ordinal);

        // Naming the key by where it actually is, which ENVMUX_HOME has moved.
        Assert.Contains(SshIdentity.KeyFileName, text, StringComparison.Ordinal);

        var again = SshConfig.Apply(["envmux"]);
        Assert.Equal(SshConfigChange.Unchanged, again.Change);
        Assert.Equal(text, File.ReadAllText(SshConfig.Location), StringComparer.Ordinal);
    }

    [Fact]
    public void AZoneAddedLaterUpdatesTheBlockAndKeepsTheOldOne()
    {
        SshConfig.Apply([HostConfig.DefaultDnsDomain]);

        var updated = SshConfig.Apply(["corp.dev"]);

        Assert.Equal(SshConfigChange.Updated, updated.Change);
        Assert.Equal([HostConfig.DefaultDnsDomain, "corp.dev"], updated.Zones);
    }
}
