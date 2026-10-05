using Envmux.Config;
using Envmux.Session;

namespace Envmux.Tests;

public class TaskPlanTests
{
    private static SessionPlan Plan(string json) =>
        SessionPlan.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Path.Combine(Path.GetTempPath(), "myproj"),
            "amber-fox");

    [Fact]
    public void ReadsTheShortForm()
    {
        var task = Plan("""{ "tasks": { "web": "npm run dev" } }""").Tasks.Single();

        Assert.Equal("web", task.Name);
        Assert.Equal([.. TaskPlan.Shell, "npm run dev"], task.Command);
        Assert.Equal("npm run dev", task.Display);
        Assert.True(task.Autostart);
        Assert.Equal(RestartPolicy.Never, task.Restart);
    }

    [Fact]
    public void ReadsTheListForm()
    {
        // No shell: the list form is chosen precisely so nothing splits or
        // expands what is in it.
        var task = Plan("""{ "tasks": { "web": ["npm", "run", "dev"] } }""").Tasks.Single();

        Assert.Equal(["npm", "run", "dev"], task.Command);
    }

    [Fact]
    public void ReadsTheLongForm()
    {
        var task = Plan("""
            {
              "tasks": {
                "worker": {
                  "command": "rake jobs:work",
                  "workdir": "/work/api",
                  "env": { "QUEUE": "default" },
                  "autostart": false,
                  "restart": "on-failure"
                }
              }
            }
            """).Tasks.Single();

        Assert.Equal("/work/api", task.Workdir);
        Assert.Equal("default", task.Env["QUEUE"]);
        Assert.False(task.Autostart);
        Assert.Equal(RestartPolicy.OnFailure, task.Restart);
    }

    [Fact]
    public void DefaultsToTheSessionsWorkdir() =>
        Assert.Equal("/somewhere", Plan("""{ "workdir": "/somewhere", "tasks": { "a": "x" } }""").Tasks[0].Workdir);

    [Fact]
    public void EveryTaskCarriesTheMarkerItIsFoundBy()
    {
        // There is no pid to signal — the engine does not report an exec's, and
        // a pidfile stops being true the moment the task forks a worker.
        var task = Plan("""{ "tasks": { "web": "npm run dev" } }""").Tasks.Single();
        Assert.Equal("web", task.Env[EnvKeys.Task]);
    }

    [Fact]
    public void SlugsNamesSoTheyAreSafeToSignalBy() =>
        Assert.Equal("api-v2", Plan("""{ "tasks": { "api:v2": "x" } }""").Tasks[0].Name);

    [Fact]
    public void RefusesATaskWithNothingToRun() =>
        Assert.Throws<ConfigException>(() => Plan("""{ "tasks": { "web": "" } }"""));

    [Fact]
    public void RefusesTwoNamesThatSlugToOne()
    {
        // They would be two tasks envmux cannot tell apart when signalling one.
        var e = Assert.Throws<ConfigException>(() => Plan("""{ "tasks": { "api:v2": "x", "api-v2": "y" } }"""));
        Assert.Contains("api-v2", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesAFieldATaskDoesNotHave()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "tasks": { "web": { "command": "x", "restarts": "always" } } }"""));

        Assert.Contains("restarts", e.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("never", "Never")]
    [InlineData("on-failure", "OnFailure")]
    [InlineData("always", "Always")]
    public void ReadsEveryRestartPolicy(string written, string expected) =>
        Assert.Equal(
            expected,
            Plan($$"""{ "tasks": { "a": { "command": "x", "restart": "{{written}}" } } }""").Tasks[0].Restart.ToString());

    [Fact]
    public void SaysWhatARestartPolicyCanBe()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "tasks": { "a": { "command": "x", "restart": "sometimes" } } }"""));

        Assert.Contains("on-failure", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryTaskCarriesItsOwnNameInTheEnvironment()
    {
        // It is no longer how a task's processes are found for signalling — a
        // latch is a named process group — but it is still the answer to "what
        // started this?" from a shell inside the instance.
        Assert.Equal("web", Plan("""{ "tasks": { "web": "x" } }""").Tasks[0].Env[EnvKeys.Task]);
    }
}

public class TaskDependencyTests
{
    private static SessionPlan Plan(string json) =>
        SessionPlan.Resolve(
            System.Text.Json.JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Path.Combine(Path.GetTempPath(), "myproj"),
            "amber-fox");

    private const string WithDatabase = """
        {
          "services": { "db": { "type": "postgres" } },
          "tasks": {
            "web":     { "command": "npm run dev", "dependsOn": "migrate", "ready": 3000 },
            "migrate": { "command": "npm run migrate", "kind": "once", "dependsOn": "db" }
          }
        }
        """;

    [Fact]
    public void ATaskCanDependOnAService()
    {
        var migrate = Plan(WithDatabase).Tasks.Single(t => t.Name == "migrate");
        var db = migrate.DependsOn.Single();

        Assert.True(db.IsService);
        Assert.Equal("db", db.Name);

        // Resolved to the endpoint that answers for it: the engine calling a
        // Postgres container healthy is not the same as it taking a connection.
        Assert.Equal(5432, db.Port);
        Assert.False(string.IsNullOrEmpty(db.Host));
    }

    [Fact]
    public void ATaskCanDependOnATask()
    {
        var web = Plan(WithDatabase).Tasks.Single(t => t.Name == "web");
        var migrate = web.DependsOn.Single();

        Assert.False(migrate.IsService);
        Assert.Equal("migrate", migrate.Name);
    }

    [Fact]
    public void DependenciesComeBeforeWhatNeedsThem()
    {
        var order = Plan(WithDatabase).Tasks.Select(t => t.Name).ToList();

        // Declared web-then-migrate; ordered migrate-then-web.
        Assert.Equal(["migrate", "web"], order);
    }

    [Fact]
    public void ReadsBothFormsOfDependsOn()
    {
        var plan = Plan("""
            {
              "tasks": {
                "a": "x",
                "b": "y",
                "c": { "command": "z", "dependsOn": ["a", "b"] }
              }
            }
            """);

        Assert.Equal(2, plan.Tasks.Single(t => t.Name == "c").DependsOn.Count);
    }

    [Fact]
    public void OngoingIsTheDefault() =>
        Assert.Equal("Ongoing", Plan("""{ "tasks": { "a": "x" } }""").Tasks[0].Kind.ToString());

    [Fact]
    public void OnceIsSaidExplicitly() =>
        Assert.Equal(
            "Once",
            Plan("""{ "tasks": { "a": { "command": "x", "kind": "once" } } }""").Tasks[0].Kind.ToString());

    [Fact]
    public void SaysWhatAKindCanBe()
    {
        var e = Assert.Throws<System.Text.Json.JsonException>(() =>
            Plan("""{ "tasks": { "a": { "command": "x", "kind": "daemon" } } }"""));

        Assert.Contains("ongoing", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesAReadyPortOnATaskThatFinishes()
    {
        // A task that is meant to exit is ready when it has exited. Waiting for
        // it to open a port would wait forever.
        var e = Assert.Throws<ConfigException>(() =>
            Plan("""{ "tasks": { "a": { "command": "x", "kind": "once", "ready": 3000 } } }"""));

        Assert.Contains("finished", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesADependencyThatIsNeitherTaskNorService()
    {
        // Otherwise it presents as a task that simply never starts, with
        // nothing on screen saying why.
        var e = Assert.Throws<ConfigException>(() =>
            Plan("""{ "tasks": { "a": { "command": "x", "dependsOn": "nope" } } }"""));

        Assert.Contains("nope", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesACircle()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "tasks": {
                "a": { "command": "x", "dependsOn": "b" },
                "b": { "command": "y", "dependsOn": "c" },
                "c": { "command": "z", "dependsOn": "a" }
              }
            }
            """));

        Assert.Contains("circle", e.Message, StringComparison.Ordinal);
        Assert.Contains("→", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefusesToDependOnItself() =>
        Assert.Throws<ConfigException>(() =>
            Plan("""{ "tasks": { "a": { "command": "x", "dependsOn": "a" } } }"""));

    [Fact]
    public void RefusesToWaitForeverOnSomethingThatNeverStarts()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "tasks": {
                "seed": { "command": "x", "autostart": false },
                "web":  { "command": "y", "dependsOn": "seed" }
              }
            }
            """));

        Assert.Contains("wait forever", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ANameThatIsBothATaskAndAServiceIsAmbiguous()
    {
        var e = Assert.Throws<ConfigException>(() => Plan("""
            {
              "services": { "db": { "type": "postgres" } },
              "tasks": { "db": "psql" }
            }
            """));

        Assert.Contains("dependsOn", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADiamondResolvesOnce()
    {
        // Two tasks depending on the same one must not visit it twice.
        var order = Plan("""
            {
              "tasks": {
                "install": { "command": "npm ci", "kind": "once" },
                "web":     { "command": "npm run dev", "dependsOn": "install" },
                "api":     { "command": "npm run api", "dependsOn": "install" },
                "e2e":     { "command": "npm test", "dependsOn": ["web", "api"] }
              }
            }
            """).Tasks.Select(t => t.Name).ToList();

        Assert.Equal(4, order.Count);
        Assert.True(order.IndexOf("install") < order.IndexOf("web"));
        Assert.True(order.IndexOf("install") < order.IndexOf("api"));
        Assert.True(order.IndexOf("web") < order.IndexOf("e2e"));
        Assert.True(order.IndexOf("api") < order.IndexOf("e2e"));
    }
}

public class BackgroundingWarningTests
{
    [Theory]
    [InlineData("npm run dev &")]
    [InlineData("nohup npm run dev")]
    [InlineData("./server & ./worker &")]
    public void NoticesSomethingBackgrounded(string command) =>
        Assert.True(Envmux.Commands.ConfigCommand.Backgrounds(command));

    [Theory]
    [InlineData("npm ci && npm run build")]
    [InlineData("dotnet --version && node --version && bun --version")]
    [InlineData("test -f x && echo yes")]
    [InlineData("npm run dev")]
    public void LeavesTheMostOrdinaryThingInACommandLineAlone(string command)
    {
        // && is not &. A warning that fires on `npm ci && npm run build` is a
        // warning people learn to ignore.
        Assert.False(Envmux.Commands.ConfigCommand.Backgrounds(command));
    }
}
public class CommandSpecTests
{
    private static CommandSpec? Parse(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<CommandSpec>(json, SessionConfig.JsonOptions);

    [Fact]
    public void AStringIsShellForm()
    {
        var spec = Parse("\"npm run dev\"")!;

        Assert.True(spec.IsShell);
        Assert.Equal(["npm run dev"], spec.Arguments);
        Assert.Equal("npm run dev", spec.ToString());
    }

    [Fact]
    public void AListIsExecForm()
    {
        var spec = Parse("""["npm", "run", "dev"]""")!;

        Assert.False(spec.IsShell);
        Assert.Equal(["npm", "run", "dev"], spec.Arguments);
    }

    [Fact]
    public void KeepsAnArgumentWithSpacesInIt()
    {
        // Splitting a string on whitespace would quietly break this, which is
        // why which form was written is kept rather than normalised away.
        var spec = Parse("""["sh", "-c", "echo hello world"]""")!;
        Assert.Equal("echo hello world", spec.Arguments[2]);
    }

    [Theory]
    [InlineData("\"\"")]
    [InlineData("[]")]
    public void RecognisesAnExplicitlyEmptyOne(string json) => Assert.True(Parse(json)!.IsEmpty);

    [Theory]
    [InlineData("3")]
    [InlineData("true")]
    [InlineData("[1, 2]")]
    public void RefusesAnythingElse(string json) =>
        Assert.Throws<System.Text.Json.JsonException>(() => Parse(json));
}
