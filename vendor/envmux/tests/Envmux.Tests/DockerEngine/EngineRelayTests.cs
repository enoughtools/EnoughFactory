using Envmux.Backends.DockerEngine;
using Envmux.Socks;

namespace Envmux.Tests.DockerEngine;

/// <summary>What <see cref="EngineRelay"/> shares with <see cref="InstanceRelay"/>, pinned. The dial itself is <see cref="EngineRelayLiveTests"/>.</summary>
public sealed class EngineRelayTests
{
    [Fact]
    public void TheMarkerIsTheOneTheSharedScriptPrints()
    {
        // The script is InstanceRelay's and the constant that names the marker
        // is private to it; this is the two agreeing.
        Assert.Contains($"printf '{EngineRelay.Connected}' >&4", InstanceRelay.Script, StringComparison.Ordinal);
        Assert.DoesNotContain('\r', InstanceRelay.Script);
    }

    [Fact]
    public async Task ARelayIsAskedForAsANonTtyExecWithStdinAsRootAndThroughRunuserForSomebody()
    {
        await using var engine = new FakeDockerEngine { ImagesMustExist = false };
        await engine.CreateContainerAsync("swarmtest-relay-fake", new ContainerCreate { Image = "golden" });
        await engine.StartAsync("swarmtest-relay-fake");

        // The fake's exec ends at once with nothing on stderr: no marker, so no connection.
        Assert.Null(await EngineRelay.DialAsync(engine, "swarmtest-relay-fake", "matt", ["localhost", "127.0.0.1"], 5173, CancellationToken.None));

        var exec = Assert.Single(engine.AllExecs).Create;

        Assert.False(exec.Tty);
        Assert.True(exec.AttachStdin);
        Assert.Equal("0:0", exec.User);
        Assert.Equal(["runuser", "-u", "matt", "--", "bash", "-c", InstanceRelay.Script, "envmux-relay", "5173", "localhost", "127.0.0.1"], exec.Cmd);

        Assert.Null(await EngineRelay.DialAsync(engine, "swarmtest-relay-fake", null, ["127.0.0.1"], 80, CancellationToken.None));
        Assert.Equal("bash", engine.AllExecs[1].Create.Cmd[0]);
    }
}
