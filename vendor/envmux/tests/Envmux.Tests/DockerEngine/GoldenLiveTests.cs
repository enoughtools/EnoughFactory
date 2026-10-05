using System.Diagnostics;

using Envmux.Backends;
using Envmux.Backends.DockerEngine;

using Xunit.Abstractions;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// The golden image, built for real through the engine, and a container from it
/// running its init.
/// </summary>
/// <remarks>
/// Opt-in with <c>ENVMUX_GOLDEN_LIVE=1</c>, because it is minutes the first
/// time and leaves <c>envmux-golden:&lt;build&gt;</c> on the engine — which is
/// the image a session on this backend runs, and so is left there on purpose.
/// The container it starts from it is <c>swarmtest-golden-…</c>, labelled
/// <c>envmux.swarmtest=1</c>, and removed.
/// </remarks>
public sealed class GoldenLiveTests(ITestOutputHelper output)
{
    [SkippableFact]
    public async Task GoldenBuildsAndItsInitStartsSshdWithKeysOnTheHomeVolume()
    {
        Skip.If(Environment.GetEnvironmentVariable("ENVMUX_GOLDEN_LIVE") is not "1", "set ENVMUX_GOLDEN_LIVE=1 to build the golden image on this engine");

        await using var engine = DockerEngineClient.Connect();

        try
        {
            await engine.VersionAsync();
        }
        catch (DockerEngineException e)
        {
            Skip.If(true, e.Message);
        }

        var images = new DockerImages(engine, new DockerBackendConfig());
        var said = new List<string>();

        var clock = Stopwatch.StartNew();
        await images.BuildGoldenAsync(said.Add);
        output.WriteLine($"{images.GoldenImage} built in {clock.Elapsed.TotalSeconds:F0} s ({said.Count} lines)");

        Assert.True(await images.HasGoldenAsync());

        var image = await engine.ImageAsync(images.GoldenImage);
        Assert.NotNull(image);
        Assert.Equal(GoldenContext.Build, image.Labels[DockerImages.Labels.Golden]);
        Assert.Equal("golden", image.Labels[DockerImages.Labels.Kind]);

        var container = $"swarmtest-golden-{Guid.NewGuid().ToString("N")[..6]}";
        var volume = $"{container}-home";
        var labels = new Dictionary<string, string>(StringComparer.Ordinal) { ["envmux.swarmtest"] = "1" };

        try
        {
            await engine.CreateVolumeAsync(volume, labels);

            // As DockerSpec makes a session: the image's own command, /home a volume.
            await engine.CreateContainerAsync(container, new ContainerCreate
            {
                Image = images.GoldenImage,
                Labels = labels,
                Mounts = [new MountSpec("volume", volume, "/home")],
            });

            clock.Restart();
            await engine.StartAsync(container);

            var exec = new EngineExec(engine);

            var up = await UntilAsync(
                async () =>
                {
                    var check = await exec.CapturedAsync(container, ["sh", "-c", "pgrep -x sshd >/dev/null && ls /home/.envmux/ssh"]);
                    return check.Ok ? check : throw new InvalidOperationException(check.Text);
                },
                TimeSpan.FromSeconds(30));

            output.WriteLine($"sshd up {clock.ElapsedMilliseconds} ms after start; keys: {up.Text.ReplaceLineEndings(" ")}");
            Assert.Contains("ssh_host_ed25519_key", up.Text, StringComparison.Ordinal);

            var tools = await exec.CapturedAsync(container, ["sh", "-c", "command -v tmux bash socat git claude runuser"]);
            Assert.True(tools.Ok, tools.Text);
            output.WriteLine(tools.Text.ReplaceLineEndings(" "));

            // The relay works from golden too: a port nothing listens on is null, quickly.
            clock.Restart();
            Assert.Null(await EngineRelay.DialAsync(engine, container, null, ["127.0.0.1"], 18099, CancellationToken.None));
            output.WriteLine($"a refused dial from golden came back in {clock.ElapsedMilliseconds} ms");

            // A stop is a SIGTERM the init traps, not a ten-second wait.
            clock.Restart();
            await engine.StopAsync(container, 10);
            output.WriteLine($"stop took {clock.ElapsedMilliseconds} ms");
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), "the init did not take SIGTERM");
        }
        finally
        {
            await engine.RemoveAsync(container, force: true, volumes: true);
            await engine.RemoveVolumeAsync(volume);
        }
    }

    private static async Task<T> UntilAsync<T>(Func<Task<T>> attempt, TimeSpan within)
    {
        var clock = Stopwatch.StartNew();

        while (true)
        {
            try
            {
                return await attempt();
            }
            catch (Exception e) when (e is InvalidOperationException or BackendException)
            {
                if (clock.Elapsed > within)
                {
                    throw;
                }

                await Task.Delay(250);
            }
        }
    }
}
