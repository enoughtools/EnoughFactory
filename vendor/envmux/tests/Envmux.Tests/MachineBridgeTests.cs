using System.Diagnostics;

namespace Envmux.Tests;

public class MachineBridgeTests
{
    [Fact]
    public void SelfSpawnRetainsOwnedEngineWithoutBorrowingDescriptorOrWorkspaceAuthority()
    {
        var child = new ProcessStartInfo("envmux");
        child.Environment["ENVMUX_BOOTSTRAP_FD"] = "3";
        child.Environment["ENVMUX_WORKSPACE_BIND"] = "/var/lib/enoughfactory/workspaces/attempt/repo";
        child.Environment["ENVMUX_ARTIFACT_STATE_VOLUME"] = "enoughfactory-afs-attempt";
        child.Environment["ENVMUX_MANAGED_DOCKER"] = "1";
        child.Environment["ENVMUX_MANAGED_GOLDEN_IMAGE"] = "sha256:" + new string('a', 64);
        child.Environment["ENVMUX_DOCKER_HOST"] = "unix:///private/factory/docker.sock";
        child.Environment["ENVMUX_DOCKER_BRIDGE_HOST"] = "192.168.5.2";

        MachineBridge.PrepareChild(child);

        Assert.False(child.Environment.ContainsKey("ENVMUX_BOOTSTRAP_FD"));
        Assert.False(child.Environment.ContainsKey("ENVMUX_WORKSPACE_BIND"));
        Assert.False(child.Environment.ContainsKey("ENVMUX_ARTIFACT_STATE_VOLUME"));
        Assert.False(child.Environment.ContainsKey("ENVMUX_MANAGED_GOLDEN_IMAGE"));
        Assert.Equal("1", child.Environment["ENVMUX_MANAGED_DOCKER"]);
        Assert.Equal("unix:///private/factory/docker.sock", child.Environment["ENVMUX_DOCKER_HOST"]);
        Assert.Equal("192.168.5.2", child.Environment["ENVMUX_DOCKER_BRIDGE_HOST"]);
    }
}
