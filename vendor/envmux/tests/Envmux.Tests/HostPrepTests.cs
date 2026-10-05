using System.Text;
using System.Text.Json;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The script a host's owner is asked to run as root, read before it is run.
/// </summary>
/// <remarks>
/// What can be said about a shell script without a shell is said here: what it
/// is built from, what it must never contain, and the promises that are visible
/// in its text. That it actually runs was checked by running it — in a Debian
/// container with a real iptables and a DOCKER-USER chain, under shellcheck,
/// as a user with sudo — and is not checked here, because a test that shelled
/// out to bash would skip on the one platform this is developed on.
/// </remarks>
public class HostPrepTests
{
    private static readonly string Script = HostPrep.Script("envmux0", "10.100.0.1/24", "envmux");

    [Fact]
    public void ItIsShippedToLinuxFromWindows()
    {
        Assert.DoesNotContain('\r', Script);
        Assert.DoesNotContain('\t', Script);
        Assert.EndsWith("ENVMUX_PREPARE\n", Script, StringComparison.Ordinal);
    }

    [Fact]
    public void ItSaysWhatItIsForBeforeItDoesAnything()
    {
        var lines = Script.Split('\n');

        Assert.StartsWith("# envmux host prepare", lines[0], StringComparison.Ordinal);
        Assert.Contains("#   network  envmux0  (10.100.0.0/24)", lines);
        Assert.Contains("#   client   envmux", lines);

        // Nothing unfilled, anywhere.
        Assert.DoesNotContain("__", Script.Replace("__pycache__", "", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Fact]
    public void PastedIntoATerminalItCannotCloseIt()
    {
        var lines = Script.Split('\n');
        var first = Array.FindIndex(lines, l => !l.StartsWith('#'));

        // Everything runs in a child bash reading a quoted here-document, so
        // `set -e` and `exit` belong to the child — and being quoted, nothing in
        // it is expanded by the shell it was pasted into.
        Assert.Equal("bash -s -- \"$@\" <<'ENVMUX_PREPARE'", lines[first]);
        Assert.Equal("set -euo pipefail", lines[first + 1]);
        Assert.Single(lines, l => l == "ENVMUX_PREPARE");
    }

    [Fact]
    public void HereDocumentsEndAtTheMargin()
    {
        // A terminator with a space in front of it is not one, and the script
        // would swallow itself to the end of the file.
        var lines = Script.Split('\n');

        foreach (var terminator in new[] { "ENVMUX_PREPARE", "ENVMUX_ROOT", "UNITFILE" })
        {
            Assert.Single(lines, l => l == terminator);
            Assert.DoesNotContain(lines, l => l != terminator && l.Trim() == terminator);
        }
    }

    [Fact]
    public void TheListenAddressIsSetOnlyWhenNobodyHasSetOne()
    {
        var set = Script.IndexOf("incus config set core.https_address :8443 </dev/null", StringComparison.Ordinal);
        var guard = Script.LastIndexOf("if [ -z \"$listen\" ]; then", set, StringComparison.Ordinal);
        var otherwise = Script.IndexOf("(left as it is)", set, StringComparison.Ordinal);

        Assert.True(guard >= 0 && guard < set && set < otherwise);

        // And it is the only place the script writes to the daemon's config. The
        // other mention is advice, printed for a person to act on or not.
        Assert.Single(
            Script.Split('\n'),
            l => l.Contains("incus config set", StringComparison.Ordinal) && !l.Contains("warn ", StringComparison.Ordinal));
    }

    [Fact]
    public void RootIsAskedForOnceAndSaysWhy()
    {
        Assert.Equal(1, Count(Script, "sudo bash -s"));
        Assert.Contains("sudo is asked for once", Script, StringComparison.Ordinal);

        // Nothing else escalates: no sudo in front of individual commands,
        // which is how a script ends up asking four times.
        Assert.DoesNotContain(Script.Split('\n'), l => l.TrimStart().StartsWith("sudo ", StringComparison.Ordinal));
    }

    [Fact]
    public void EveryChangeIsBehindTheCheckFlag()
    {
        var lines = Script.Split('\n');

        string[] changes =
        [
            "incus config set core.https_address",
            "> /etc/sysctl.d/90-envmux-forward.conf",
            "sysctl -q -w",
            "cat > \"/etc/systemd/system/$UNIT\"",
            "systemctl enable",
            "systemctl restart",
            "ufw route allow in on \"$BRIDGE\"",
            "ufw route allow out on \"$BRIDGE\"",
        ];

        foreach (var change in changes)
        {
            var at = Array.FindIndex(lines, l => l.Contains(change, StringComparison.Ordinal));
            Assert.True(at > 0, change);

            // The nearest `if` above it that mentions CHECK is the guard, and the
            // line is inside it: nothing between them steps back out to the
            // guard's own indentation. The unit file's body sits at the margin
            // because a here-document's does, so it is stepped over.
            var guard = Array.FindLastIndex(lines, at, l => l.Contains("\"$CHECK\" = 0", StringComparison.Ordinal));
            Assert.True(guard >= 0, $"{change} has no CHECK guard above it");

            var inUnit = false;
            for (var i = guard + 1; i < at; i++)
            {
                if (lines[i].EndsWith("<<UNITFILE", StringComparison.Ordinal) || lines[i] == "UNITFILE")
                {
                    inUnit = !inUnit;
                    continue;
                }

                Assert.True(
                    inUnit || lines[i].Length == 0 || Indent(lines[i]) > Indent(lines[guard]),
                    $"{change} is outside its CHECK guard: '{lines[i]}' closes it first");
            }
        }

        // The token is the other thing that changes the host — a pending entry
        // in its trust store — and --check leaves before it.
        var exit = Script.IndexOf("ENVMUX-TOKEN: none (--check)", StringComparison.Ordinal);
        var mint = Script.IndexOf("incus config trust add \"$NAME\"", StringComparison.Ordinal);
        Assert.True(exit > 0 && exit < mint);
    }

    [Fact]
    public void TheFirewallIsMatchedByInterfaceNotByRange()
    {
        Assert.Contains("-I DOCKER-USER -i $BRIDGE -j ACCEPT", Script, StringComparison.Ordinal);
        Assert.Contains("-I DOCKER-USER -o $BRIDGE -j ACCEPT", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("-s $RANGE", Script, StringComparison.Ordinal);
        Assert.DoesNotContain("-d $RANGE", Script, StringComparison.Ordinal);

        // Checked before inserted, so that running it twice, or a unit
        // restarting, never stacks a second copy of the rule.
        Assert.Equal(2, Count(Script, "iptables -w -C DOCKER-USER"));

        Assert.Contains("After=docker.service", Script, StringComparison.Ordinal);
    }

    [Fact]
    public void AnOwnersOwnMechanismIsLeftAlone()
    {
        Assert.Contains("already handled by $keeper (left alone)", Script, StringComparison.Ordinal);
    }

    [Fact]
    public void NothingIsDownloaded()
    {
        foreach (var fetch in new[] { "curl", "wget", "apt-get", "apt ", "pip ", "http://", "https://" })
        {
            Assert.DoesNotContain(fetch, Script, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void TheTokenIsTheLastThingPrinted()
    {
        var lines = Script.Split('\n', StringSplitOptions.RemoveEmptyEntries);

        Assert.Equal("ENVMUX_PREPARE", lines[^1]);
        Assert.Equal("printf 'ENVMUX-TOKEN: %s\\n' \"$token\"", lines[^2]);
        Assert.StartsWith("ENVMUX-TOKEN: ", HostPrep.TokenMarker, StringComparison.Ordinal);
    }

    [Fact]
    public void CheckCanBeBakedInForAScriptThatIsPasted()
    {
        Assert.Contains("\nCHECK=0\n", Script, StringComparison.Ordinal);
        Assert.Contains("\nCHECK=1\n", HostPrep.Script("envmux0", "10.100.0.1/24", "envmux", check: true), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("incusbr0", "10.252.20.1/24", "10.252.20.0/24")]
    [InlineData("envmux0", "10.100.0.1/16", "10.100.0.0/16")]
    [InlineData("br.lab_2", "172.30.5.129/25", "172.30.5.128/25")]
    public void TheRangeIsSaidAsANetwork(string network, string cidr, string expected)
    {
        var script = HostPrep.Script(network, cidr, "envmux");

        Assert.Contains($"BRIDGE='{network}'\n", script, StringComparison.Ordinal);
        Assert.Contains($"RANGE='{expected}'\n", script, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "10.100.0.1/24", "envmux")]
    [InlineData("envmux0; reboot", "10.100.0.1/24", "envmux")]
    [InlineData("a-name-longer-than-fifteen", "10.100.0.1/24", "envmux")]
    [InlineData("envmux0", "10.100.0.1", "envmux")]
    [InlineData("envmux0", "10.100.0.1/24'; reboot; '", "envmux")]
    [InlineData("envmux0", "fd42::1/64", "envmux")]
    [InlineData("envmux0", "10.100.0.1/24", "")]
    [InlineData("envmux0", "10.100.0.1/24", "--help")]
    [InlineData("envmux0", "10.100.0.1/24", "matt's laptop")]
    [InlineData("envmux0", "10.100.0.1/24", "$(id)")]
    public void WhatCannotBeWrittenIntoAShellScriptIsRefused(string network, string cidr, string name)
    {
        Assert.Throws<ArgumentException>(() => HostPrep.Script(network, cidr, name));
    }

    private static readonly string[] Addresses = ["192.168.19.43:8443"];

    private static string Token() =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["client_name"] = "envmux",
            ["fingerprint"] = new string('c', 64),
            ["addresses"] = Addresses,
            ["secret"] = "opens-nothing",
            ["expires_at"] = "0001-01-01T00:00:00Z",
        })));

    [Fact]
    public void TheTokenIsReadOffTheLastMarkedLine()
    {
        var token = Token();

        // As it comes back over `ssh -t`: a carriage return on every line.
        var output =
            "envmux host prepare: network envmux0 (10.100.0.0/24), client envmux\r\n" +
            "  ok     incus 7.0.1 answers this account\r\n" +
            "\r\n" +
            $"ENVMUX-TOKEN: {token}\r\n" +
            "Connection to prompt-app-26 closed.\r\n";

        Assert.Equal(token, HostPrep.TokenFrom(output));
    }

    [Fact]
    public void ACheckRunHasNoToken()
    {
        Assert.Null(HostPrep.TokenFrom("  would  mint a one-time trust token\nENVMUX-TOKEN: none (--check)\n"));
        Assert.Null(HostPrep.TokenFrom("  FAILED incus is not installed here.\n"));
        Assert.Null(HostPrep.TokenFrom(""));
    }

    [Fact]
    public void SshGetsTheScriptAsAnArgumentSoTheTerminalStaysSudos()
    {
        var argv = HostPrep.SshCommandLine("matt@prompt-app-26", Script, check: false);

        Assert.Equal(["ssh", "-t", "matt@prompt-app-26"], argv.Take(3));
        Assert.Equal(4, argv.Count);

        // Not `bash -s`: the script on stdin would take the terminal away from
        // sudo. What travels is base64, so there is no quoting left to get
        // wrong between PowerShell, ssh and the login shell on the far side.
        Assert.DoesNotContain("bash -s", argv[3], StringComparison.Ordinal);
        Assert.StartsWith("bash -c \"$(printf %s ", argv[3], StringComparison.Ordinal);
        Assert.EndsWith(" | base64 -d)\" envmux-prepare", argv[3], StringComparison.Ordinal);

        var encoded = argv[3].Split(' ')[4];
        Assert.Equal(Script, Encoding.UTF8.GetString(Convert.FromBase64String(encoded)));

        // Windows caps a command line at 32,767 characters.
        Assert.True(argv.Sum(a => a.Length + 3) < 30_000, "the ssh command line is too long for CreateProcess");
    }

    [Fact]
    public void CheckIsPassedThroughSsh()
    {
        Assert.EndsWith(
            " envmux-prepare --check",
            HostPrep.SshCommandLine("prompt-app-26", Script, check: true)[3],
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("-oProxyCommand=calc")]
    [InlineData("matt@host rm -rf")]
    [InlineData("matt@host\n")]
    public void AnSshTargetThatWouldBeReadAsSomethingElseIsRefused(string target)
    {
        Assert.Throws<ArgumentException>(() => HostPrep.SshCommandLine(target, Script, check: false));
    }

    private static int Indent(string line) => line.Length - line.TrimStart().Length;

    private static int Count(string text, string value)
    {
        var count = 0;
        for (var at = text.IndexOf(value, StringComparison.Ordinal); at >= 0; at = text.IndexOf(value, at + 1, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
