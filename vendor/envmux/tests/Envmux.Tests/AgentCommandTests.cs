using System.Text.Json;

using Envmux.Agents;
using Envmux.Commands;
using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The <c>agent</c> command's grammar, and the plan it hands a remote agent.
/// </summary>
public class AgentCommandTests : IDisposable
{
    public void Dispose()
    {
        GC.SuppressFinalize(this);
        CommandName.OverrideForTesting(null);
    }

    private static SessionPlan Plan(string config = """{"name":"proj"}""") =>
        SessionPlan.Resolve(JsonSerializer.Deserialize<SessionConfig>(config, SessionConfig.JsonOptions)!, Directory.GetCurrentDirectory(), "feat-login");

    [Fact]
    public void ParsesAStartWithAnInlinePrompt()
    {
        var asked = AgentCommand.Parse(["start", "feat-login", "--prompt", "Add a login page", "--as", "hazel"]);

        Assert.Equal("start", asked.Verb);
        Assert.Equal("feat-login", asked.Name);
        Assert.Equal("Add a login page", asked.Prompt);
        Assert.Null(asked.PromptFile);
        Assert.Equal("hazel", asked.Nick);
    }

    [Fact]
    public void ParsesAStartWithAPromptFile()
    {
        var asked = AgentCommand.Parse(["start", "feat-login", "--prompt-file", "task.md"]);

        Assert.Equal("task.md", asked.PromptFile);
        Assert.Equal(Chatroom.DefaultNick, asked.Nick);
    }

    [Fact]
    public void LetsAStartReadItsPromptFromStdin()
    {
        // Neither given is legal: the command reads the task from a pipe.
        var asked = AgentCommand.Parse(["start", "feat-login"]);

        Assert.Null(asked.Prompt);
        Assert.Null(asked.PromptFile);
    }

    [Theory]
    [InlineData(new[] { "start" }, "needs the agent's name")]
    [InlineData(new[] { "start", "a", "b" }, "one name, not 2")]
    [InlineData(new[] { "start", "a", "--prompt", "x", "--prompt-file", "y" }, "use one")]
    [InlineData(new[] { "start", "a", "--prompt" }, "--prompt needs a value")]
    [InlineData(new[] { "start", "a", "--as", "Hazel" }, "not a name the room accepts")]
    [InlineData(new[] { "stop" }, "needs the agent's name")]
    [InlineData(new[] { "say" }, "needs something to say")]
    [InlineData(new[] { "say", "hi", "--to", "7up" }, "not a name the room accepts")]
    [InlineData(new[] { "read", "extra" }, "takes no arguments")]
    [InlineData(new[] { "read", "--buckets", "0" }, "positive number")]
    [InlineData(new[] { "ls", "--bogus" }, "unknown option")]
    [InlineData(new[] { "dance" }, "not an agent command")]
    [InlineData(new string[0], "needs a command")]
    public void RefusesALineItCannotUse(string[] args, string complaint)
    {
        var refused = Assert.Throws<AgentUsageException>(() => AgentCommand.Parse(args));

        Assert.Contains(complaint, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void HelpIsUsageWithNothingToComplainAbout()
    {
        var help = Assert.Throws<AgentUsageException>(() => AgentCommand.Parse(["start", "--help"]));

        Assert.Equal("", help.Message);
    }

    [Fact]
    public void JoinsWhatIsSaidAndTakesAnAddressee()
    {
        var asked = AgentCommand.Parse(["say", "start", "with", "the", "tests", "--to", "feat-login", "--as", "hazel"]);

        Assert.Equal("start with the tests", asked.Text);
        Assert.Equal("feat-login", asked.To);
        Assert.Equal("hazel", asked.Nick);
    }

    [Fact]
    public void ReadsBackAsManyBucketsAsAskedAndFollows()
    {
        Assert.Equal(Chatroom.RecentBuckets, AgentCommand.Parse(["read"]).Buckets);

        var asked = AgentCommand.Parse(["read", "--buckets", "8", "--follow"]);

        Assert.Equal(8, asked.Buckets);
        Assert.True(asked.Follow);
        Assert.True(AgentCommand.Parse(["logs", "feat-login", "-f"]).Follow);
    }

    [Fact]
    public void TakesAPortalLinkForTheThinClient()
    {
        var asked = AgentCommand.Parse(["ls", "--portal", "http://127.0.0.1:8080/?k=abc"]);

        Assert.Equal("http://127.0.0.1:8080/?k=abc", asked.Portal);
    }

    [Fact]
    public void TheAgentIsOneMoreTaskDeclaredByEnvmux()
    {
        var plan = AgentCommand.WithAgent(
            Plan("""{"name":"proj","tasks":{"install":{"command":"npm ci","kind":"once"},"web":{"command":"npm run dev"},"seed":{"command":"npm run seed","kind":"once","autostart":false}}}"""),
            "Add a login page.",
            "feat-login",
            "hazel",
            TimeSpan.FromHours(12));

        var agent = Assert.Single(plan.Tasks, t => t.Name == AgentRegistry.TaskName);

        Assert.True(agent.IsInternal);
        Assert.Equal(TaskKind.Once, agent.Kind);
        Assert.Equal(["sh", "-lc", AgentPrompt.Command], agent.Command);
        Assert.Equal(plan.Workdir, agent.Workdir);

        // Waits on the installs, not on the dev server, and not on a task that
        // does not start on its own.
        Assert.Equal(["install"], agent.DependsOn.Select(d => d.Name));

        // The briefing travels in the task's environment, and it is the wrapped one.
        var briefing = agent.Env[AgentPrompt.PromptVariable];
        Assert.Contains("You are `feat-login`", briefing, StringComparison.Ordinal);
        Assert.Contains("Add a login page.", briefing, StringComparison.Ordinal);
        Assert.Contains("envmux/feat-login", briefing, StringComparison.Ordinal);
        Assert.Contains(".context/chatroom", briefing, StringComparison.Ordinal);
        Assert.Contains("@hazel", briefing, StringComparison.Ordinal);
        Assert.Contains("signing off", briefing, StringComparison.Ordinal);
        Assert.Contains("--dangerously-skip-permissions", agent.Command[^1], StringComparison.Ordinal);

        // The clock, so `date` in the instance agrees with the room's buckets here.
        Assert.Equal("ENVMUX-12", plan.Env["TZ"]);
        Assert.Equal("#proj", plan.Env["ENVMUX_ROOM"]);
        Assert.Equal("feat-login", plan.Env["ENVMUX_AGENT"]);
    }

    [Fact]
    public void LeavesAConfiguredTimeZoneAlone()
    {
        var plan = AgentCommand.WithAgent(Plan("""{"name":"proj","env":{"TZ":"Pacific/Auckland"}}"""), "task", "x", "chef", TimeSpan.FromHours(12));

        Assert.Equal("Pacific/Auckland", plan.Env["TZ"]);
    }

    /// <summary>
    /// The room travels with the agent: a client task, and the API in the agent's own environment.
    /// </summary>
    /// <remarks>
    /// The token is in two execs' environments and nowhere else — not in the
    /// session's environment, which is written to <c>/etc/profile.d</c> in the
    /// instance and put on the instance's config.
    /// </remarks>
    [Fact]
    public void TheRoomComesWithTheAgent()
    {
        var plan = AgentCommand.WithAgent(Plan(), "task", "feat-login", "chef", TimeSpan.Zero);

        var room = Assert.Single(plan.Tasks, RoomClient.Is);
        var agent = Assert.Single(plan.Tasks, t => t.Name == AgentRegistry.TaskName);

        Assert.Equal([RoomClient.Program], room.Command);
        Assert.Equal(plan.Workdir, room.Workdir);
        Assert.Equal(RestartPolicy.Always, room.Restart);
        Assert.Empty(room.DependsOn);

        Assert.Equal(Portal.ApiBridge.InsideUrl, room.Env[Portal.ApiBridge.UrlVariable]);
        Assert.Equal(plan.Portal.RoomToken, room.Env[Portal.ApiBridge.TokenVariable]);
        Assert.Equal(Portal.ApiBridge.InsideUrl, agent.Env[Portal.ApiBridge.UrlVariable]);
        Assert.Equal(plan.Portal.RoomToken, agent.Env[Portal.ApiBridge.TokenVariable]);

        Assert.DoesNotContain(Portal.ApiBridge.TokenVariable, plan.Env.Keys);
        Assert.DoesNotContain(Portal.ApiBridge.UrlVariable, plan.Env.Keys);
    }

    /// <summary>No token, no room: there is no second credential, so the agent works alone.</summary>
    [Fact]
    public void LeavesTheRoomOutWhenThePortalHasNoToken()
    {
        var plan = AgentCommand.WithAgent(Plan("""{"name":"proj","portal":{"token":false}}"""), "task", "x", "chef", TimeSpan.Zero);

        Assert.DoesNotContain(plan.Tasks, RoomClient.Is);
        Assert.DoesNotContain(Portal.ApiBridge.TokenVariable, Assert.Single(plan.Tasks, t => t.Name == AgentRegistry.TaskName).Env.Keys);
    }

    [Fact]
    public void RefusesAProjectThatAlreadyHasATaskCalledAgent()
    {
        var refused = Assert.Throws<AgentException>(() =>
            AgentCommand.WithAgent(Plan("""{"name":"proj","tasks":{"agent":"echo hi"}}"""), "task", "x", "chef", TimeSpan.Zero));

        Assert.Contains("'agent'", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Exited", true)]
    [InlineData("Failed", true)]
    [InlineData("Blocked", true)]
    [InlineData("Stopped", true)]
    [InlineData("Running", false)]
    [InlineData("Waiting", false)]
    [InlineData("Idle", false)]
    public void KnowsWhenTheAgentsTaskIsOver(string state, bool over)
    {
        // By name, because the enum is internal and a public theory cannot take it.
        Assert.Equal(over, AgentCommand.IsOver(Enum.Parse<TaskState>(state)));
    }

    /// <summary>The local briefing is run by an agent, so it names the binary that printed it.</summary>
    [Fact]
    public void TheLocalBriefingNamesTheCommandThatPrintedIt()
    {
        var prompt = AgentPrompt.Local("devenvmux");

        Assert.Contains("devenvmux agent start <name> --prompt", prompt, StringComparison.Ordinal);
        Assert.Contains("devenvmux agent read --follow", prompt, StringComparison.Ordinal);
        Assert.Contains("devenvmux agent stop <name>", prompt, StringComparison.Ordinal);
        Assert.Contains("git merge envmux/<name>", prompt, StringComparison.Ordinal);

        // No instruction may name the source's spelling of the binary. The prose
        // may say "envmux agent" — the title does — but nothing shaped like a
        // command to run.
        Assert.DoesNotMatch(@"(?<![\w-])envmux agent (start|ls|say|read|stop|logs|prompt|run)\b", prompt);
    }

    [Fact]
    public void TheRemoteBriefingTeachesTheRoomWithoutNamingEnvmuxCommands()
    {
        var briefing = AgentPrompt.Remote(Plan(), "feat-login", "Do the thing.", "chef");

        Assert.Contains("printf '[%s] feat-login: %s\\n' \"$(date +%H:%M)\"", briefing, StringComparison.Ordinal);
        Assert.Contains("find .context/chatroom -name '*.txt' | sort | tail -4", briefing, StringComparison.Ordinal);
        Assert.Contains("10#$(date +%M) / 15 * 15", briefing, StringComparison.Ordinal);
        Assert.Contains("#proj", briefing, StringComparison.Ordinal);
        Assert.Contains("/work", briefing, StringComparison.Ordinal);
        Assert.Contains("do not try to push", briefing, StringComparison.Ordinal);
        Assert.EndsWith("Do the thing.\n\n", briefing.ReplaceLineEndings("\n"), StringComparison.Ordinal);

        // The agent has no envmux in its instance; nothing should send it to one.
        Assert.DoesNotContain("envmux agent", briefing, StringComparison.Ordinal);
    }
}
