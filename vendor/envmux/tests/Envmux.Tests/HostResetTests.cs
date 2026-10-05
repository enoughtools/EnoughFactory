using Envmux.Commands;
using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// Reset is the one command that destroys a host on purpose, so the thing worth
/// pinning is that it will not do so by accident. And <c>wire</c>, which used to
/// change this workstation's routing table, must now change nothing.
/// </summary>
[Collection(HostHome.Name)]
public class HostResetTests
{
    /// <summary>
    /// <c>host wire</c> is a message: it exits 0, names <c>unwire</c>, and asks nothing of Windows.
    /// </summary>
    /// <remarks>
    /// The playbooks people followed named it, and a script somebody kept may
    /// still call it. It cannot be "not a thing envmux does" — that exits 2 and
    /// prints the whole usage — and it must not be a wire, because there is
    /// nothing to wire. A scratch home proves it reads nothing it would need one for.
    /// </remarks>
    [Fact]
    public async Task WireIsAMessageAndTouchesNothing()
    {
        var home = Directory.CreateTempSubdirectory("envmux-wire");
        var stdout = Console.Out;
        var captured = new StringWriter();

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home.FullName);
            Console.SetOut(captured);

            var code = await HostCommand.RunAsync(["wire"]);

            Assert.Equal(0, code);
            Assert.Contains("no longer", captured.ToString(), StringComparison.Ordinal);
            Assert.Contains("host unwire", captured.ToString(), StringComparison.Ordinal);
            Assert.Empty(Directory.EnumerateFileSystemEntries(home.FullName));
        }
        finally
        {
            Console.SetOut(stdout);
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
            home.Delete(recursive: true);
        }
    }

    /// <summary>
    /// A reset with no <c>--yes</c>, run where nothing can answer the question,
    /// tears nothing down.
    /// </summary>
    /// <remarks>
    /// The teardown is irreversible and the confirmation is the only thing
    /// between a stray invocation and a destroyed host. A redirected stdin — a
    /// script, a CI job, a test — cannot say yes, so the command must refuse
    /// rather than assume it, and it must refuse <em>before</em> it removes
    /// anything. Asserted by leaving a marker in the home and checking it
    /// survives.
    /// </remarks>
    [Fact]
    public async Task ARedirectedResetWithoutYesDestroysNothing()
    {
        var home = Directory.CreateTempSubdirectory("envmux-reset");

        try
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", home.FullName);

            new HostConfig { Api = "10.0.0.5:8443", Provider = HostConfig.HyperV }.Save();
            var marker = Path.Combine(home.FullName, "envmux-cli.key");
            File.WriteAllText(marker, "not a real key, but it must not vanish");

            // xUnit runs with a redirected stdin, so the confirmation cannot be
            // answered and --yes was not passed.
            var code = await HostCommand.RunAsync(["reset"]);

            Assert.Equal(2, code);
            Assert.True(File.Exists(marker));
            Assert.True(File.Exists(HostConfig.Location));
        }
        finally
        {
            Environment.SetEnvironmentVariable("ENVMUX_HOME", null);
            home.Delete(recursive: true);
        }
    }
}
