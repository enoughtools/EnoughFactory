using System.Text.Json;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;
using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;
using Envmux.Tests.DockerEngine;

namespace Envmux.Tests;

public sealed class SessionRestartTests
{
    private static SessionConfig Config(string json) =>
        JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!;

    private static SessionPlan Plan(string json = "{}") =>
        SessionPlan.Resolve(Config(json), Path.GetTempPath(), "restart-regression");

    [Fact]
    public void ReloadKeepsBrowserAndGuestCredentialsWhileApplyingTaskChanges()
    {
        var current = Plan("""{"tasks":{"work":"echo before"}}""") with
        {
            ManagedGoldenImage = "sha256:" + new string('a', 64),
        };
        var next = SessionRestart.Resolve(current, Config("""{"tasks":{"work":"echo after"}}"""));

        Assert.Equal(current.Portal.Token, next.Portal.Token);
        Assert.Equal(current.Portal.RoomToken, next.Portal.RoomToken);
        Assert.Equal(current.ManagedGoldenImage, next.ManagedGoldenImage);
        Assert.Equal("echo after", Assert.Single(next.Tasks).Display);
    }

    [Theory]
    [InlineData("{}", "{\"portal\":{\"token\":false}}")]
    [InlineData("{}", "{\"portal\":{\"enabled\":false}}")]
    [InlineData("{\"portal\":{\"token\":false}}", "{}")]
    [InlineData("{\"portal\":{\"enabled\":false}}", "{}")]
    public void AuthenticationChangesRequireAFullStopAndStart(string before, string after)
    {
        var current = Plan(before);
        var error = Assert.Throws<SessionException>(() => SessionRestart.Resolve(current, Config(after)));
        Assert.Contains("stopping this session", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(current.Portal.Token.Length > 0 ? current.Portal.Token : "not-a-token", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnExitedRetainedContainerStartsByItsIdAndKeepsItsFiles()
    {
        await using var engine = new FakeDockerEngine { ImagesMustExist = false };
        var plan = Plan();
        await CreateAsync(engine, plan);
        await using var backend = new DockerBackend(engine, new DockerBackendConfig());
        var retained = (await backend.Instances.GetAsync(plan.InstanceName))!;
        engine.AddFile(plan.InstanceName, "/work/uncommitted.swift", "retained source");
        Assert.False(retained.IsRunning);

        var address = await SessionRestart.EnsureInstanceAsync(backend, plan, retained);

        Assert.NotEmpty(address);
        Assert.True((await backend.Instances.GetAsync(plan.InstanceName))!.IsRunning);
        Assert.Equal(retained.BackendId, engine.Container(plan.InstanceName)!.Id);
        Assert.Contains(engine.Calls, call => call.Operation == "Start" && call.Subject == retained.BackendId);
        Assert.Equal("retained source", engine.FileIn(plan.InstanceName, "/work/uncommitted.swift")!.Text);
        Assert.Single(engine.Created);
        Assert.Equal(0, engine.Count("Remove"));
        Assert.Equal(0, engine.Count("Pull"));
    }

    [Fact]
    public async Task ARunningContainerDoesNotRestartItsProcesses()
    {
        await using var engine = new FakeDockerEngine { ImagesMustExist = false };
        var plan = Plan();
        await CreateAsync(engine, plan);
        await engine.StartAsync(plan.InstanceName);
        await using var backend = new DockerBackend(engine, new DockerBackendConfig());
        var retained = (await backend.Instances.GetAsync(plan.InstanceName))!;

        _ = await SessionRestart.EnsureInstanceAsync(backend, plan, retained);

        Assert.Equal(1, engine.Count("Start"));
        Assert.Equal(0, engine.Count("Stop"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AMissingOrReplacedContainerIsNeverCreatedOrStarted(bool replacement)
    {
        await using var engine = new FakeDockerEngine { ImagesMustExist = false };
        var plan = Plan();
        await CreateAsync(engine, plan);
        await using var backend = new DockerBackend(engine, new DockerBackendConfig());
        var retained = (await backend.Instances.GetAsync(plan.InstanceName))!;
        await engine.RemoveAsync(plan.InstanceName);
        if (replacement)
        {
            await CreateAsync(engine, plan);
        }
        var created = engine.Created.Count;

        await Assert.ThrowsAsync<SessionException>(() => SessionRestart.EnsureInstanceAsync(backend, plan, retained));

        Assert.Equal(created, engine.Created.Count);
        Assert.Equal(0, engine.Count("Start"));
    }

    private static async Task CreateAsync(FakeDockerEngine engine, SessionPlan plan)
    {
        engine.AddNetwork(DockerBackend.Network);
        var spec = InstanceSpec.ForSession(plan, new HostConfig(), false, DateTimeOffset.UnixEpoch);
        await engine.CreateContainerAsync(plan.InstanceName, DockerSpec.ForInstance(spec, DockerBackend.Network, new DockerBackendConfig()));
    }
}
