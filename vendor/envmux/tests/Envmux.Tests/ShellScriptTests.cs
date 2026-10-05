using System.Text;

using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// No script that leaves this machine may carry a carriage return.
/// </summary>
/// <remarks>
/// <para>
/// This is the bug that hides on CI. <c>StringBuilder.AppendLine</c> ends a line
/// with <see cref="Environment.NewLine"/>, so on Linux every script is fine and
/// on a Windows workstation every script is CRLF — and the Windows workstation is
/// the only place envmux is used from. The golden build failed with
/// <c>sh: 1: set: Illegal option -</c>, which is dash reading <c>set -eu\r</c>.
/// </para>
/// <para>
/// The failures that do not announce themselves are worse: <c>cd /work\r</c> is a
/// directory that does not exist, and a variable whose value ends in a control
/// character compares equal to nothing.
/// </para>
/// <para>
/// So the scripts are asserted rather than the helper. A future line written with
/// <c>AppendLine</c> fails here on the machine it would fail on in real life.
/// </para>
/// </remarks>
public class ShellScriptTests
{
    private static void NoCarriageReturns(string script, string what)
    {
        var at = script.IndexOf('\r', StringComparison.Ordinal);

        if (at < 0)
        {
            return;
        }

        var line = script[..at].Split('\n').Length;

        Assert.Fail(
            $"{what} has a carriage return on line {line.ToString(System.Globalization.CultureInfo.InvariantCulture)} " +
            $"({script[..at].Split('\n').Last()}). A POSIX shell reads it as part of the last word — " +
            "use .Line() rather than .AppendLine().");
    }

    /// <summary>The toolchain the golden instance is built with.</summary>
    [Fact]
    public void TheGoldenProvisionScriptIsLfOnly()
    {
        var script = Golden.Provision();

        NoCarriageReturns(script, "Golden.Provision()");
        Assert.StartsWith("set -eu\n", script, StringComparison.Ordinal);
    }

    /// <summary>The account, the sudoers drop-in, the working directory and its session-named link.</summary>
    [Fact]
    public void TheBootstrapScriptIsLfOnly() =>
        NoCarriageReturns(Bootstrap.Script("matt", "/work/thing", "/myproj_feat-login"), "Bootstrap.Script()");

    /// <summary>
    /// The room's client, and the script that installs it.
    /// </summary>
    /// <remarks>
    /// The client is the one script envmux ships that runs for the life of a
    /// session rather than once, so a carriage return in it would be a client
    /// that fails on every pass. The install is a quoted heredoc, so the
    /// terminator must not appear in the body — or the shell would end the file
    /// early and run the rest as commands.
    /// </remarks>
    [Fact]
    public void TheRoomClientAndItsInstallAreLfOnly()
    {
        var client = Agents.RoomClient.Script();
        var install = Agents.RoomClient.InstallScript();

        NoCarriageReturns(client, "RoomClient.Script()");
        NoCarriageReturns(install, "RoomClient.InstallScript()");

        Assert.StartsWith("#!/bin/sh\n", client, StringComparison.Ordinal);
        Assert.DoesNotContain("ENVMUX_ROOM_CLIENT", client, StringComparison.Ordinal);

        Assert.Contains($"cat > {Agents.RoomClient.InstallPath} <<'ENVMUX_ROOM_CLIENT'\n", install, StringComparison.Ordinal);
        Assert.Contains("\nENVMUX_ROOM_CLIENT\n", install, StringComparison.Ordinal);
        Assert.Contains($"chmod 0755 {Agents.RoomClient.InstallPath}", install, StringComparison.Ordinal);

        // It signs in with what its exec was given, reads the wire form, and
        // asks with a cursor — and never writes the token anywhere.
        Assert.Contains("ENVMUX_API_URL", client, StringComparison.Ordinal);
        Assert.Contains("ENVMUX_API_TOKEN", client, StringComparison.Ordinal);
        Assert.Contains("Authorization: Bearer %s", client, StringComparison.Ordinal);
        Assert.Contains("--config -", client, StringComparison.Ordinal);
        Assert.DoesNotContain("-H \"Authorization: Bearer $token\"", client, StringComparison.Ordinal);
        Assert.Contains("Accept: text/plain", client, StringComparison.Ordinal);
        Assert.Contains("after=$cursor", client, StringComparison.Ordinal);
        // Header names arrive in whatever case the server chose; the sed that
        // reads the cursor does not care.
        Assert.Contains("[Xx]-[Ee]nvmux-[Cc]ursor", client, StringComparison.Ordinal);
        Assert.Contains(".git/info/exclude", client, StringComparison.Ordinal);
        Assert.DoesNotContain("echo \"$token\"", client, StringComparison.Ordinal);
        Assert.DoesNotContain("$token >", client, StringComparison.Ordinal);
    }

    /// <summary>The agent install, which is the other script golden runs.</summary>
    [Fact]
    public void TheAgentInstallScriptIsLfOnly()
    {
        var script = Golden.InstallAgent();

        NoCarriageReturns(script, "Golden.InstallAgent()");

        // Root's copy goes, because this image is cloned for every session and
        // root's signed-in agent is not anybody's.
        Assert.Contains("rm -rf /root/.local/share/claude", script, StringComparison.Ordinal);

        // Somewhere every account can reach, not one home directory.
        Assert.Contains("/usr/local/bin/claude", script, StringComparison.Ordinal);
        Assert.Contains(Golden.AgentDirectory, script, StringComparison.Ordinal);
    }

    /// <summary>
    /// The session environment, which is what makes `services` mean anything.
    /// </summary>
    /// <remarks>
    /// It was computed, shown by --dry-run, and dropped. A task running
    /// <c>psql -h "$DB_HOST"</c> got <c>-h ""</c>, fell back to a local socket,
    /// and failed with a message about <c>/var/run/postgresql</c> — the wrong
    /// machine entirely.
    /// </remarks>
    [Fact]
    public void TheSessionEnvironmentScriptIsLfOnly()
    {
        var script = Bootstrap.EnvironmentScript(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["DB_HOST"] = "footprint-dev-db.envmux",
            ["DB_PORT"] = "5432",
        });

        NoCarriageReturns(script, "Bootstrap.EnvironmentScript()");

        Assert.Contains("export DB_HOST='footprint-dev-db.envmux'", script, StringComparison.Ordinal);
        Assert.Contains(Bootstrap.EnvironmentProfile, script, StringComparison.Ordinal);
    }

    /// <summary>
    /// A generated password cannot become shell.
    /// </summary>
    /// <remarks>
    /// These are random strings from an alphabet nobody constrained, so a
    /// backtick or a $ in one is a matter of time — and an unquoted one is a
    /// command substitution in every shell that reads the profile.
    /// </remarks>
    [Fact]
    public void APasswordCannotBecomeShell()
    {
        var script = Bootstrap.EnvironmentScript(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["DB_PASSWORD"] = "a`whoami`b$USER'c",
        });

        var line = script
            .Split('\n')
            .Single(l => l.StartsWith("export DB_PASSWORD=", StringComparison.Ordinal));

        // The whole value single-quoted, with each quote in it closed, escaped
        // and reopened. A shell reading this sees one word and expands nothing:
        // the backtick and the $USER are inside quotes, and the quote the value
        // contained is a backslash-escaped literal between two quoted runs.
        Assert.Equal(@"export DB_PASSWORD='a`whoami`b$USER'\''c'", line);
    }

    /// <summary>
    /// An exec as somebody gets that somebody's HOME.
    /// </summary>
    /// <remarks>
    /// An exec is not a login: incus runs the command as the uid it was given
    /// and sets nothing else, so $HOME is simply absent — and a great many
    /// things read it without checking. The Aspire installer is one, failing
    /// with <c>main: line 1057: HOME: unbound variable</c>. ssh and `su -` set
    /// it themselves, which is why it looks fine to anyone who checks by hand.
    /// </remarks>
    [Fact]
    public void AnExecAsSomebodyGetsAHome()
    {
        var env = Envmux.Incus.Command.EnvironmentFor("matt", null);

        Assert.Equal("/home/matt", env["HOME"]);
        Assert.Equal("matt", env["USER"]);
        Assert.Equal("matt", env["LOGNAME"]);

        // And still everything the defaults carried.
        Assert.Equal("xterm-256color", env["TERM"]);
    }

    /// <summary>As root, nothing is asserted over what the caller passed.</summary>
    [Fact]
    public void AnExecAsRootIsLeftAlone()
    {
        var env = Envmux.Incus.Command.EnvironmentFor(null, null);

        Assert.False(env.ContainsKey("HOME"));
        Assert.False(env.ContainsKey("USER"));
    }

    /// <summary>A caller that set HOME meant it.</summary>
    [Fact]
    public void ACallersOwnHomeWins()
    {
        var env = Envmux.Incus.Command.EnvironmentFor(
            "matt",
            new Dictionary<string, string>(StringComparer.Ordinal) { ["HOME"] = "/somewhere/else" });

        Assert.Equal("/somewhere/else", env["HOME"]);
        Assert.Equal("matt", env["USER"]);
    }

    /// <summary>
    /// Running as somebody means their groups, not just their uid.
    /// </summary>
    /// <remarks>
    /// Measured in a session instance: asking the exec API for uid 1001 gives
    /// <c>uid=1001(matt) gid=0(root) groups=0(root)</c>. The right user, the
    /// <em>root</em> primary group, and none of their own — so every task wrote
    /// files group-owned by root, and every group-granted permission was
    /// missing. Docker reports that one as "found but appears to be unhealthy".
    /// </remarks>
    [Fact]
    public void RunningAsSomebodyGoesThroughRunuser()
    {
        var command = Envmux.Incus.Command.AsUser("matt", ["tmux", "new-session", "-d", "-s", "x"]);

        Assert.Equal(["runuser", "-u", "matt", "--", "tmux", "new-session", "-d", "-s", "x"], command);
    }

    /// <summary>
    /// Argv, so nothing is re-quoted on the way through.
    /// </summary>
    /// <remarks>
    /// The reason for runuser over `su -c`: a task's command is already a shell
    /// fragment inside a shell fragment, and a third round of quoting is a place
    /// to be wrong about somebody's password.
    /// </remarks>
    [Fact]
    public void TheCommandIsNotRequoted()
    {
        var awkward = "sh -c 'echo \"it's\" $HOME'";
        var command = Envmux.Incus.Command.AsUser("matt", ["sh", "-c", awkward]);

        Assert.Equal(awkward, command[^1]);
    }

    /// <summary>As root there is nobody to become.</summary>
    [Fact]
    public void AsRootTheCommandIsUnchanged() =>
        Assert.Equal(["id"], Envmux.Incus.Command.AsUser(null, ["id"]));

    /// <summary>
    /// The keys that let the editor attach, and the modes sshd insists on.
    /// </summary>
    /// <remarks>
    /// Without this, `envmux code` handed out a vscode-remote:// URI and nothing
    /// could connect: sshd answered `Permission denied (publickey,password)`,
    /// because the account is created with no password and no authorized_keys.
    /// </remarks>
    [Fact]
    public void TheAuthorizedKeysScriptIsLfOnly()
    {
        var script = Bootstrap.AuthorizedKeysScript(
            "matt",
            ["ssh-ed25519 AAAAC3Nz mattf@takahe", "ssh-rsa AAAAB3Nz other@host"]);

        NoCarriageReturns(script, "Bootstrap.AuthorizedKeysScript()");

        Assert.Contains("ssh-ed25519 AAAAC3Nz mattf@takahe", script, StringComparison.Ordinal);
        Assert.Contains("ssh-rsa AAAAB3Nz other@host", script, StringComparison.Ordinal);

        // sshd refuses a key file anyone else can write, and says so only in its
        // own log — from the client it is an ordinary permission denied.
        Assert.Contains("chmod 0700 '/home/matt/.ssh'", script, StringComparison.Ordinal);
        Assert.Contains("chmod 0600 '/home/matt/.ssh/authorized_keys'", script, StringComparison.Ordinal);
        // The trailing colon sets the group to the account's own, where a bare
        // name leaves whatever group root created it with.
        Assert.Contains("chown -R 'matt:' '/home/matt/.ssh'", script, StringComparison.Ordinal);

        // Written whole, so starting a session twice does not accumulate the
        // same key and a key removed from this machine stops working here too.
        Assert.Contains("cat > '/home/matt/.ssh/authorized_keys'", script, StringComparison.Ordinal);
        Assert.DoesNotContain(">> '/home/matt/.ssh/authorized_keys'", script, StringComparison.Ordinal);
    }

    /// <summary>What counts as a public key, and what is a comment.</summary>
    [Theory]
    [InlineData("ssh-ed25519 AAAAC3Nz matt@takahe", true)]
    [InlineData("ssh-rsa AAAAB3Nz matt@takahe", true)]
    [InlineData("ecdsa-sha2-nistp256 AAAAE2 matt@takahe", true)]
    [InlineData("sk-ssh-ed25519@openssh.com AAAAG matt@takahe", true)]
    [InlineData("# a comment", false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    public void AKeyIsRecognisedByItsType(string line, bool expected) =>
        Assert.Equal(expected, Envmux.Editor.HostKeys.LooksLikeAKey(line.Trim()));

    /// <summary>The helper itself, so the reason the others pass is the right one.</summary>
    [Fact]
    public void LineEndsALineTheWayAShellDoes()
    {
        var script = new StringBuilder().Line("set -eu").Line().Line("echo hello").ToString();

        Assert.Equal("set -eu\n\necho hello\n", script);
    }
}
