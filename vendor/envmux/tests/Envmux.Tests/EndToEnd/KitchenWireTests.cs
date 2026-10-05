using Envmux.Backends.DockerEngine;

namespace Envmux.Tests.EndToEnd;

public sealed class KitchenWireTests
{
    public static TheoryData<string> Cases => Targets.Names();

    [SkippableTheory]
    [MemberData(nameof(Cases))]
    public async Task GuestChefCallsItsScopedApiWithoutBrowserCredentials(string name)
    {
        Skip.If(name == Targets.Unset, $"set {Targets.Variable}=docker to verify the guest kitchen wire");
        var target = Targets.Find(name)!;
        if (target.Backend != "docker")
        {
            return;
        }

        await using var session = await SessionUnderTest.StartAsync(target, "chef", chef: true);
        var instance = await session.InstanceAsync(TimeSpan.FromMinutes(5));
        await session.WaitForAsync(RoomWired(), TimeSpan.FromMinutes(5));
        await using var engine = DockerEngineClient.Connect();
        var result = await new EngineExec(engine).CapturedAsync(instance, ["sh", "-c", """
            set -eu
            test -n "$(find /home -path '*/.agents/skills/envmux-chef/SKILL.md' -print -quit)" || { echo 'guest skill missing'; exit 1; }
            . /etc/profile.d/envmux-session.sh
            test -n "$ENVMUX_CHEF_TOKEN" || { echo 'chef capability missing'; exit 1; }
            curl --fail --silent --show-error --max-time 20 --connect-timeout 5 --config - <<EOF
            url = "$ENVMUX_CHEF_URL/api/kitchen/agents"
            header = "Authorization: Bearer $ENVMUX_CHEF_TOKEN"
            EOF
            cd "$ENVMUX_WORKDIR"
            day=$(date +%F)
            minute=$(date +%M); minute=${minute#0}
            bucket=$(printf '%s%02d' "$(date +%H)" "$((minute / 15 * 15))")
            mkdir -p ".context/chatroom/$day"
            printf '[%s] chef: guest-chef-wire-proof\n' "$(date +%H:%M)" >> ".context/chatroom/$day/$bucket.txt"
            """]);
        Assert.True(result.Ok, result.Text);
        Assert.Contains("\"agents\"", result.Text, StringComparison.Ordinal);
        var arrived = false;
        for (var attempt = 0; attempt < 30 && !arrived; attempt++)
        {
            var room = await session.CommandAsync("agent", "read");
            arrived = room.Code == 0 && room.Output.Contains("guest-chef-wire-proof", StringComparison.Ordinal);
            if (!arrived)
            {
                await Task.Delay(500);
            }
        }

        Assert.True(arrived, "the guest's room line did not reach the workstation");
        Assert.True(await session.StopAsync(TimeSpan.FromMinutes(3)));
        Assert.Equal(0, session.ExitCode);
    }

    private static System.Text.RegularExpressions.Regex RoomWired() =>
        new("room: .* is carried into", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
}
