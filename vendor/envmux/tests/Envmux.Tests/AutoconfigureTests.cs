using Envmux.Commands;
using Envmux.Config;

namespace Envmux.Tests;

public class AutoconfigureTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-ac-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        CommandName.OverrideForTesting(null);

        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp directory is not worth failing a test over.
        }
    }

    [Fact]
    public void NamesTheCommandThatPrintedIt()
    {
        // An agent handed a prompt saying "envmux config validate" ran exactly
        // that, reached an unrelated older envmux on the PATH, and concluded
        // the prompt was wrong. The prompt has to name itself.
        CommandName.OverrideForTesting("devenvmux");
        var prompt = AutoconfigureCommand.Prompt(_dir);

        Assert.Contains("devenvmux config validate", prompt, StringComparison.Ordinal);
        Assert.Contains("devenvmux config schema", prompt, StringComparison.Ordinal);
        Assert.Contains("devenvmux --dry-run", prompt, StringComparison.Ordinal);

        // And nowhere should it tell the reader to run something else.
        Assert.DoesNotContain("envmux config validate", prompt.Replace("devenvmux", "X", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Fact]
    public void WarnsAboutTheOtherToolThatMightBeOnThePath()
    {
        var prompt = AutoconfigureCommand.Prompt(_dir);
        Assert.Contains(".envmux.toml", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void TellsTheAgentHowToCheckItsWork()
    {
        var prompt = AutoconfigureCommand.Prompt(_dir);

        Assert.Contains("config validate", prompt, StringComparison.Ordinal);
        Assert.Contains("config show", prompt, StringComparison.Ordinal);
        Assert.Contains("config schema", prompt, StringComparison.Ordinal);
        Assert.Contains("--dry-run", prompt, StringComparison.Ordinal);
        Assert.Contains("exits 0", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void TellsTheAgentWhenToAskRatherThanGuess()
    {
        var prompt = AutoconfigureCommand.Prompt(_dir);

        Assert.Contains("ask the user", prompt, StringComparison.OrdinalIgnoreCase);

        // The one that carries real credentials into a machine that outlives the
        // session, which is the decision most worth not making on somebody's
        // behalf now that there is no bind mount to revoke.
        Assert.Contains("tools", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void CarriesTheWholeFieldReference()
    {
        // The agent should never have to guess whether a field exists, because
        // the loader rejects the ones that do not.
        var prompt = AutoconfigureCommand.Prompt(_dir);

        foreach (var field in ConfigReference.Fields)
        {
            Assert.Contains(field.Path, prompt, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ReportsWhatItCanSeeInTheDirectory()
    {
        File.WriteAllText(Path.Combine(_dir, "package.json"), "{}");
        File.WriteAllText(Path.Combine(_dir, "compose.yaml"), "");

        var prompt = AutoconfigureCommand.Prompt(_dir);

        Assert.Contains("package.json", prompt, StringComparison.Ordinal);
        Assert.Contains("compose.yaml", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void SaysWhenThereIsAlreadyAConfigToImproveOn()
    {
        // The first line is the instruction, so it is the one that has to change:
        // an agent told to "write" a file that exists will write over it.
        var bare = AutoconfigureCommand.Prompt(_dir);
        Assert.StartsWith("Write an", bare, StringComparison.Ordinal);
        Assert.DoesNotContain("Read it before you change anything", bare, StringComparison.Ordinal);

        File.WriteAllText(Path.Combine(_dir, SessionConfig.FileName), "{}");
        var existing = AutoconfigureCommand.Prompt(_dir);

        Assert.StartsWith("Update this repository's", existing, StringComparison.Ordinal);
        Assert.Contains("Read it before you change anything", existing, StringComparison.Ordinal);
        Assert.Contains("Do not replace it wholesale", existing, StringComparison.Ordinal);
    }

    [Fact]
    public void HandsTheClaudeInvocationTheWholePromptAsAnArgument()
    {
        // Not piped: writing this file is a conversation — which script starts
        // the dev server, is that database real — and stdin closed by a pipe
        // has nowhere to ask.
        var invocations = AutoconfigureCommand.Invocations("envmux");

        Assert.Contains("claude \"$(envmux autoconfigure)\"", invocations, StringComparison.Ordinal);
        Assert.DoesNotContain("| claude", invocations, StringComparison.Ordinal);
    }

    [Fact]
    public void TheExampleItShowsIsValid()
    {
        // A prompt whose own example does not parse would teach the agent to
        // write something that does not parse.
        var prompt = AutoconfigureCommand.Prompt(_dir);
        var start = prompt.IndexOf("```jsonc", StringComparison.Ordinal);
        Assert.True(start > 0, "the prompt should carry a worked example");

        start = prompt.IndexOf('\n', start) + 1;
        var end = prompt.IndexOf("```", start, StringComparison.Ordinal);
        var example = prompt[start..end];

        File.WriteAllText(Path.Combine(_dir, SessionConfig.FileName), example);
        var plan = Session.SessionPlan.Resolve(SessionConfig.Load(_dir), _dir, "s");

        Assert.Equal("storefront", plan.Project);
        Assert.Single(plan.Routes);
        Assert.Single(plan.Services);
    }
}

public class StrictConfigTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("envmux-strict-").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private ConfigException Load(string json)
    {
        File.WriteAllText(Path.Combine(_dir, SessionConfig.FileName), json);
        return Assert.Throws<ConfigException>(() => SessionConfig.Load(_dir));
    }

    [Fact]
    public void AnInventedFieldIsRejectedAndNamed()
    {
        // The whole point of an agent loop: a hallucinated field has to fail,
        // and the failure has to say which field.
        var e = Load("""{ "volumes": { "cache": "/tmp" } }""");

        Assert.Contains("'volumes'", e.Message, StringComparison.Ordinal);
        Assert.Contains("config schema", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATypoIsRejectedRatherThanIgnored()
    {
        // Silently ignoring "rotues" would produce a session with no routes and
        // no explanation, which is the worst outcome available.
        Assert.Contains("'rotues'", Load("""{ "rotues": { "web": 3000 } }""").Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnInventedServiceFieldIsRejectedToo() =>
        Assert.Contains("'replicas'", Load("""{ "services": { "db": { "type": "postgres", "replicas": 3 } } }""").Message, StringComparison.Ordinal);

    [Fact]
    public void TheMessageDoesNotLeakDotNetTypeNames()
    {
        // The reader is a person or an agent, and neither cares which CLR type
        // the property failed to bind to.
        var message = Load("""{ "nope": 1 }""").Message;

        Assert.DoesNotContain("SessionConfig", message, StringComparison.Ordinal);
        Assert.DoesNotContain(".NET", message, StringComparison.Ordinal);
    }
}
