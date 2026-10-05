using System.Text.Json;

using Envmux.Agents;
using Envmux.Commands;
using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The on-disk registry of remote agents, with the spawn faked.
/// </summary>
/// <remarks>
/// No process is started and no host is reached. What is under test is the
/// contract two processes share through <c>.envmux/agents/</c>: what
/// <c>start</c> writes, what a listing reads, and how a record whose process
/// has gone is reported.
/// </remarks>
public class AgentRegistryTests : IDisposable
{
    private readonly string _repo = Directory.CreateTempSubdirectory("envmux-agents-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        CommandName.OverrideForTesting(null);

        try
        {
            Directory.Delete(_repo, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    private SessionPlan Plan(string session, string config = """{"name":"proj","tools":{"claude":"auto"}}""") =>
        SessionPlan.Resolve(JsonSerializer.Deserialize<SessionConfig>(config, SessionConfig.JsonOptions)!, _repo, session);

    /// <summary>A spawn that starts nothing and answers with a pid that is certainly alive: this one's.</summary>
    private static int Alive(string repository, IReadOnlyList<string> arguments) => Environment.ProcessId;

    [Fact]
    public void StartWritesTheTaskThenTheRecord()
    {
        IReadOnlyList<string>? spawned = null;

        var record = AgentRegistry.Start(_repo, Plan("feat-login"), "Add a login page.\nUse the existing form component.", "hazel",
            (_, args) =>
            {
                spawned = args;
                return 4242;
            });

        Assert.Equal("feat-login", record.Name);
        Assert.Equal("envmux/feat-login", record.Branch);
        Assert.Equal("proj-feat-login", record.Instance);
        Assert.Equal("feat-login", record.Nick);
        Assert.Equal("hazel", record.Delegator);
        Assert.Equal("Add a login page.", record.Summary);
        Assert.Equal(4242, record.Pid);
        Assert.Equal(AgentState.Launching, record.State);

        Assert.Equal("Add a login page.\nUse the existing form component.", File.ReadAllText(AgentRegistry.PromptPath(_repo, "feat-login")));
        Assert.True(File.Exists(AgentRegistry.LogPath(_repo, "feat-login")));
        Assert.Equal(record, AgentRegistry.Load(_repo, "feat-login"));

        // The child is this binary, told to be the agent, in this repository.
        Assert.Equal(["-C", _repo, "agent", "run", "feat-login"], spawned);
    }

    [Fact]
    public void RefusesASecondAgentByTheSameNameWhileTheFirstIsAlive()
    {
        AgentRegistry.Start(_repo, Plan("feat-login"), "task", spawn: Alive);

        var refused = Assert.Throws<AgentException>(() => AgentRegistry.Start(_repo, Plan("feat-login"), "again", spawn: Alive));

        Assert.Contains("already", refused.Message, StringComparison.Ordinal);
        Assert.Contains("agent stop feat-login", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LetsANameBeReusedOnceItsProcessHasGone()
    {
        // A pid nothing can have, so the first record reads as stopped.
        AgentRegistry.Start(_repo, Plan("feat-login"), "task", spawn: (_, _) => int.MaxValue);

        var again = AgentRegistry.Start(_repo, Plan("feat-login"), "second try", spawn: Alive);

        Assert.Equal("second try", again.Summary);
    }

    [Fact]
    public void ReportsARecordWhoseProcessHasGoneAsStopped()
    {
        var running = new AgentRecord("x", "proj", "envmux/x", "proj-x", "x", "t", DateTimeOffset.UtcNow, int.MaxValue, AgentState.Running);
        var finished = running with { State = AgentState.Finished, Pid = int.MaxValue };

        Assert.Equal(AgentState.Stopped, AgentRegistry.Reconcile(running).State);
        Assert.NotNull(AgentRegistry.Reconcile(running).EndedAt);

        // A finished one is finished, whatever its pid is doing.
        Assert.Equal(AgentState.Finished, AgentRegistry.Reconcile(finished).State);
    }

    [Fact]
    public void ListsMostRecentFirstAndSkipsWhatItCannotRead()
    {
        AgentRegistry.Start(_repo, Plan("older"), "one", spawn: Alive);
        AgentRegistry.Save(_repo, AgentRegistry.Load(_repo, "older")! with { StartedAt = DateTimeOffset.UtcNow.AddHours(-1) });
        AgentRegistry.Start(_repo, Plan("newer"), "two", spawn: Alive);

        File.WriteAllText(AgentRegistry.RecordPath(_repo, "broken"), "{ not json");

        Assert.Equal(["newer", "older"], AgentRegistry.List(_repo).Select(r => r.Name));
    }

    [Fact]
    public void AStopIsAFileTheAgentPollsFor()
    {
        Assert.False(AgentRegistry.StopRequested(_repo, "x"));

        AgentRegistry.RequestStop(_repo, "x");
        Assert.True(AgentRegistry.StopRequested(_repo, "x"));

        AgentRegistry.ClearStop(_repo, "x");
        Assert.False(AgentRegistry.StopRequested(_repo, "x"));
    }

    [Theory]
    [InlineData("Add a login page.", "Add a login page.")]
    [InlineData("\n\n  Second line is the first non-empty one  \nthird", "Second line is the first non-empty one")]
    [InlineData("", "")]
    public void SummarisesTheFirstLine(string prompt, string summary)
    {
        Assert.Equal(summary, AgentRegistry.Summarise(prompt));
    }

    [Fact]
    public void CutsALongFirstLineToFitAListing()
    {
        var summary = AgentRegistry.Summarise(new string('x', 100));

        Assert.Equal(70, summary.Length);
        Assert.EndsWith("…", summary, StringComparison.Ordinal);
    }

    /// <summary>
    /// The report is read by an agent that will run what it says, so it has to
    /// name the binary that printed it — not "envmux".
    /// </summary>
    [Fact]
    public void TheStartReportNamesTheCommandThatPrintedIt()
    {
        var record = new AgentRecord("feat-login", "proj", "envmux/feat-login", "proj-feat-login", "feat-login", "Add a login page.",
            DateTimeOffset.UtcNow, 4242, AgentState.Launching);

        var report = AgentRegistry.StartReport(record, "devenvmux", claudeCarried: true);

        Assert.Contains("devenvmux agent say \"@feat-login", report, StringComparison.Ordinal);
        Assert.Contains("devenvmux agent logs feat-login --follow", report, StringComparison.Ordinal);
        Assert.Contains("devenvmux agent stop feat-login", report, StringComparison.Ordinal);
        Assert.Contains("git log envmux/feat-login", report, StringComparison.Ordinal);
        Assert.DoesNotContain("envmux agent", report.Replace("devenvmux", "X", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.DoesNotContain("warning", report, StringComparison.Ordinal);
    }

    [Fact]
    public void TheStartReportWarnsWhenClaudeWillArriveSignedOut()
    {
        var record = new AgentRecord("x", "proj", "envmux/x", "proj-x", "x", "t", DateTimeOffset.UtcNow, 1, AgentState.Launching);

        var report = AgentRegistry.StartReport(record, "envmux", claudeCarried: false);

        Assert.Contains("\"tools\": { \"claude\": \"auto\" }", report, StringComparison.Ordinal);
    }

    [Fact]
    public void DescribesWhatCameBack()
    {
        var record = new AgentRecord("x", "proj", "envmux/x", "proj-x", "x", "Do the thing", DateTimeOffset.UtcNow, 1, AgentState.Finished,
            0, new AgentResult("envmux/x", "abc12345", 3, 1));

        var line = AgentRegistry.Describe(record);

        Assert.Contains("finished — 3 commit(s) on envmux/x, 1 uncommitted in proj-x", line, StringComparison.Ordinal);
        Assert.Contains("Do the thing", line, StringComparison.Ordinal);

        var failed = AgentRegistry.Describe(record with { State = AgentState.Failed, ExitCode = 2, Result = null });
        Assert.Contains("failed — exit 2", failed, StringComparison.Ordinal);
    }

    [Fact]
    public void RecordsRoundTripThroughJson()
    {
        var record = new AgentRecord("x", "proj", "envmux/x", "proj-x", "x", "t", DateTimeOffset.UtcNow, 7, AgentState.Finished,
            0, new AgentResult("envmux/x", "abc12345", 3, 0), DateTimeOffset.UtcNow, "hazel");

        AgentRegistry.Save(_repo, record);

        Assert.Equal(record, AgentRegistry.Load(_repo, "x"));
        Assert.Contains("\"delegator\": \"hazel\"", File.ReadAllText(AgentRegistry.RecordPath(_repo, "x")), StringComparison.Ordinal);
    }
}
