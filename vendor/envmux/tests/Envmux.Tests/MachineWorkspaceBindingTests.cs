using Envmux.Backends;
using Envmux.Backends.DockerEngine;

namespace Envmux.Tests;

public class MachineWorkspaceBindingTests
{
    private const string Source = "/var/lib/enoughfactory/workspaces/attempt-123/repo";
    private const string Volume = "enoughfactory-afs-attempt-123";

    [Fact]
    public void AcceptsOnlyMatchedManagerPathsInPrivateBootstrap()
    {
        Assert.Null(MachineWorkspaceBinding.Parse(false, Source, Volume, "/work"));
        Assert.Null(MachineWorkspaceBinding.Parse(true, null, null, "/work"));
        Assert.NotNull(MachineWorkspaceBinding.Parse(true, Source, Volume, "/work"));
        Assert.Throws<BackendException>(() => MachineWorkspaceBinding.Parse(true, "/Users/someone/code", Volume, "/work"));
        Assert.Throws<BackendException>(() => MachineWorkspaceBinding.Parse(true, Source, "other-volume", "/work"));
        Assert.Throws<BackendException>(() => MachineWorkspaceBinding.Parse(true,
            "/var/lib/enoughfactory/workspaces/../repo", "enoughfactory-afs-..", "/work"));
        Assert.Throws<BackendException>(() => MachineWorkspaceBinding.Parse(true,
            "/var/lib/enoughfactory/workspaces/repo", Volume, "/work"));
        Assert.Throws<BackendException>(() => MachineWorkspaceBinding.Parse(true, Source, Volume, "/var/lib/artifact-fs/repo"));
    }

    [Fact]
    public void AuthorizesOnlyTheExactWorkspaceAndItsStateWithoutWeakeningIsolation()
    {
        var workspace = MachineWorkspaceBinding.Parse(true, Source, Volume, "/work")!;
        var container = new ContainerCreate
        {
            Image = "envmux-golden:test",
            Network = "envmux-net-test",
            Labels = new Dictionary<string, string> { [DockerSpec.Labels.Kind] = DockerSpec.SessionKind },
            Mounts =
            [
                .. workspace.BindMounts,
                new MountSpec("volume", Volume, MachineWorkspaceBinding.StateTarget),
            ],
        };

        Assert.Empty(DockerSpec.Problems(container, workspace));
        Assert.NotEmpty(DockerSpec.Problems(container));
        Assert.NotEmpty(DockerSpec.Problems(container with { Mounts = [container.Mounts[0]] }, workspace));
        Assert.NotEmpty(DockerSpec.Problems(container with
        {
            Mounts = [new MountSpec("bind", Source, "/work", Propagation: "rshared"), .. container.Mounts.Skip(1)],
        }, workspace));
        Assert.NotEmpty(DockerSpec.Problems(container with { CapAdd = ["SYS_ADMIN"] }, workspace));
        Assert.NotEmpty(DockerSpec.Problems(container with
        {
            Mounts = [.. container.Mounts, new MountSpec("bind", "/var/run/docker.sock", "/var/run/docker.sock")],
        }, workspace));
        Assert.NotEmpty(DockerSpec.Problems(container with
        {
            Labels = new Dictionary<string, string> { [DockerSpec.Labels.Kind] = DockerSpec.ServiceKind },
        }, workspace));
    }

    [Fact]
    public void WritesTheDockerBindPropagationWithoutAddingPrivilege()
    {
        var body = EngineJson.CreateBody(new ContainerCreate
        {
            Image = "envmux-golden:test",
            Network = "envmux-net-test",
            Mounts = [new MountSpec("bind", Source, "/work", Propagation: "rslave")],
        });

        Assert.Equal("rslave", body["HostConfig"]!["Mounts"]![0]!["BindOptions"]!["Propagation"]!.GetValue<string>());
        Assert.Null(body["HostConfig"]!["Privileged"]);
    }
}
