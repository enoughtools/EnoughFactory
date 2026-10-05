using System.Globalization;
using System.Text;

using Envmux.Host;

namespace Envmux.Incus;

/// <summary>What a one-shot command left behind.</summary>
/// <param name="ExitCode">What the command exited with.</param>
/// <param name="Output">Everything the terminal drew, which is both streams interleaved.</param>
internal readonly record struct RunResult(int ExitCode, string Output)
{
    public bool Ok => ExitCode == 0;

    /// <summary>The output with the terminal's carriage returns taken back out.</summary>
    public string Text => Output.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd('\n');
}

/// <summary>
/// Running one command and waiting for it, on top of the interactive exec.
/// </summary>
/// <remarks>
/// There is no non-interactive exec here by choice, so a one-shot command is an
/// interactive one nobody types into: the pty is drained until it closes and the
/// exit code comes off the operation. The cost is that stdout and stderr arrive
/// interleaved rather than separated, which for provisioning output is what you
/// wanted anyway — and the gain is one exec path instead of two.
/// </remarks>
internal static class Command
{
    /// <summary>
    /// Run a command as somebody, with the groups that come with being them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The exec API takes a uid and applies exactly that. Measured inside a
    /// session instance, asking it for uid 1001 gives
    /// <c>uid=1001(matt) gid=0(root) groups=0(root)</c> — the right user, the
    /// <em>root</em> primary group, and none of their own. Every task therefore
    /// wrote files group-owned by root, and every group-granted permission was
    /// missing: Docker reports that one as
    /// "Container runtime 'docker' was found but appears to be unhealthy",
    /// which is what it looks like from the client side.
    /// </para>
    /// <para>
    /// <c>runuser -u</c> does what logging in does — <c>initgroups</c>, the real
    /// primary group, the supplementary ones — and takes its argv after
    /// <c>--</c>, so nothing needs re-quoting on the way through. The exec
    /// itself runs as root, which is what runuser needs in order to drop.
    /// </para>
    /// <para>
    /// <c>-u</c> rather than <c>-l</c>: <c>-l</c> resets the environment, which
    /// would throw away everything the caller asked for, including the HOME
    /// that <see cref="EnvironmentFor"/> just filled in.
    /// </para>
    /// </remarks>
    /// <param name="user">Who to run as, or null to stay root.</param>
    /// <param name="command">The command, as its own arguments.</param>
    public static IReadOnlyList<string> AsUser(string? user, IReadOnlyList<string> command) =>
        string.IsNullOrWhiteSpace(user)
            ? command
            : ["runuser", "-u", user, "--", .. command];

    /// <summary>
    /// The environment an exec gets, with the account's own part filled in.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An exec is not a login. incus runs the command as the uid it was given
    /// and sets nothing else, so <c>$HOME</c> is simply absent — and a great many
    /// things read it without checking. The Aspire installer is one:
    /// <c>main: line 1057: HOME: unbound variable</c>, from a script that had no
    /// reason to expect a shell without one.
    /// </para>
    /// <para>
    /// <c>ssh</c> and <c>su -</c> set these themselves, which is why an exec is
    /// the only place it goes missing and why it looks fine the moment anyone
    /// checks by hand.
    /// </para>
    /// <para>
    /// Only when running as somebody. As root the defaults are already right,
    /// and asserting <c>/root</c> over whatever the caller passed would be a
    /// change rather than a fill-in.
    /// </para>
    /// </remarks>
    /// <param name="user">The account name, or null for root.</param>
    /// <param name="environment">What the caller asked for, which always wins.</param>
    public static IReadOnlyDictionary<string, string> EnvironmentFor(
        string? user,
        IReadOnlyDictionary<string, string>? environment)
    {
        var env = new Dictionary<string, string>(environment ?? Defaults, StringComparer.Ordinal);

        if (string.IsNullOrWhiteSpace(user))
        {
            return env;
        }

        // TryAdd, not assignment: a caller that set HOME meant it.
        env.TryAdd("HOME", Session.Bootstrap.Home(user));
        env.TryAdd("USER", user);
        env.TryAdd("LOGNAME", user);

        return env;
    }

    public static async Task<RunResult> RunAsync(
        IncusApi api,
        string instance,
        IReadOnlyList<string> command,
        string? user = null,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        Action<string>? onLine = null,
        CancellationToken ct = default)
    {
        var request = new ExecPost
        {
            Command = AsUser(user, command),
            Cwd = cwd,
            Environment = EnvironmentFor(user, environment),

            // A wide pty, because provisioning output is full of paths and a
            // command that wraps at eighty columns is a log nobody can read.
            Width = 200,
            Height = 50,
        };

        await using var exec = await ExecSession.StartAsync(api, instance, request, ct).ConfigureAwait(false);

        return await DrainAsync(exec, onLine, ct).ConfigureAwait(false);
    }

    /// <summary>The same run, on whatever backend the instance is on.</summary>
    public static async Task<RunResult> RunAsync(
        Backends.IExec backend,
        string instance,
        IReadOnlyList<string> command,
        string? user = null,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        Action<string>? onLine = null,
        CancellationToken ct = default)
    {
        var request = new Backends.ExecRequest
        {
            Command = AsUser(user, command),
            Cwd = cwd,
            Environment = EnvironmentFor(user, environment),
            Width = 200,
            Height = 50,
        };

        await using var exec = await backend.InteractiveAsync(instance, request, ct).ConfigureAwait(false);

        return await DrainAsync(exec, onLine, ct).ConfigureAwait(false);
    }

    /// <summary>Read a terminal to its end, a line at a time, and say what it exited with.</summary>
    private static async Task<RunResult> DrainAsync(
        Backends.IInteractiveExec exec,
        Action<string>? onLine,
        CancellationToken ct)
    {
        var output = new StringBuilder();
        var line = new StringBuilder();
        var buffer = new byte[8192];

        // Watched from the start, rather than after the pty closes, because the
        // pty closing is not guaranteed and the operation finishing is. They are
        // two different events: the operation ends when the command exits, and
        // the pty ends when the last thing holding it lets go — which is not the
        // command if anything it started inherited the descriptors. openssh's
        // postinst is exactly that, and a golden build sat on a finished apt for
        // eighteen minutes with an open socket and nothing left to say.
        var waiting = exec.WaitAsync(ct);

        using var draining = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // A grace period, not a race: the command has exited but its last write
        // may still be in flight, and cutting the read at the same instant would
        // lose the line that says why it failed.
        _ = waiting.ContinueWith(
            _ => draining.CancelAfter(TimeSpan.FromSeconds(2)),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        while (true)
        {
            int read;

            try
            {
                read = await exec.Terminal.ReadAsync(buffer, draining.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or System.Net.WebSockets.WebSocketException)
            {
                // The far end closed mid-read, which is what the end of a
                // command looks like when the pty goes with it.
                break;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // The command is done and the socket is not. Everything it said
                // has been read; what is left is a descriptor somebody else owns.
                break;
            }

            if (read == 0)
            {
                break;
            }

            var text = Encoding.UTF8.GetString(buffer, 0, read);
            output.Append(text);

            if (onLine is null)
            {
                continue;
            }

            foreach (var c in text)
            {
                if (c == '\n')
                {
                    onLine(line.ToString().TrimEnd('\r'));
                    line.Clear();
                }
                else
                {
                    line.Append(c);
                }
            }
        }

        if (onLine is not null && line.Length > 0)
        {
            onLine(line.ToString().TrimEnd('\r'));
        }

        return new RunResult(await waiting.ConfigureAwait(false), output.ToString());
    }

    /// <summary>
    /// Run a command with no terminal, and collect what it wrote.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The one-shot path, and the one provisioning uses. It asks for
    /// <c>record-output</c> with no websocket at all: incus runs the command with
    /// its streams going to two files, finishes the operation when the command
    /// exits, and hands back where the files are.
    /// </para>
    /// <para>
    /// Which is the whole point. The interactive path below allocates a pty and
    /// reads it until it closes — and a pty does not close when the command
    /// exits, it closes when the last process holding it lets go. Provisioning is
    /// full of things that outlive the shell that started them: a package
    /// postinst that starts a daemon, a service that inherits the descriptors it
    /// was launched with. Measured: apt finished, tmux was installed, the script
    /// had run to the end, and the exec sat open for eighteen minutes with
    /// nothing left to say. The operation stayed Running with it, so watching
    /// that instead does not help.
    /// </para>
    /// <para>
    /// The cost is that output arrives at the end rather than as it happens, so
    /// a long apt is a silence. That is a fair trade for a command that returns.
    /// </para>
    /// <para>
    /// The logs are deleted afterwards. incus keeps them on the instance
    /// otherwise, and a golden image that carries the transcript of its own build
    /// is a snapshot with rubbish in it.
    /// </para>
    /// </remarks>
    public static async Task<RunResult> CaptureAsync(
        IncusApi api,
        string instance,
        IReadOnlyList<string> command,
        string? user = null,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        CancellationToken ct = default)
    {
        var request = new ExecPost
        {
            Command = AsUser(user, command),
            Cwd = cwd,
            Environment = EnvironmentFor(user, environment),
            WaitForWebsocket = false,
            Interactive = false,
            RecordOutput = true,
        };

        var started = await api.Client
            .PostAsync($"{IncusClient.V1}/instances/{instance}/exec", request, ct)
            .ConfigureAwait(false);

        // Not api.AwaitAsync: that throws when an operation ends unsuccessfully,
        // and a command that exits non-zero is a result here rather than a
        // failure — the caller wants the exit code and the output that explains
        // it.
        var operation = await api.SettleAsync(started, null, ct).ConfigureAwait(false);

        var output = new StringBuilder();

        foreach (var (_, path) in operation.Output().OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (path.Length == 0)
            {
                continue;
            }

            var (body, _) = await api.Client.GetRawAsync(path, ct).ConfigureAwait(false);

            if (body.Length > 0)
            {
                output.Append(Encoding.UTF8.GetString(body));
            }

            try
            {
                await api.Client.DeleteAsync(path, null, ct).ConfigureAwait(false);
            }
            catch (IncusException)
            {
                // A log that will not delete is untidy. Letting that throw would
                // discard the output just read, which is the part somebody
                // needs — and it would do it precisely when the command failed,
                // because that is when anyone looks.
            }
        }

        // The operation's own failure, when the command produced nothing to
        // explain it. A feature that would not install, reported as
        // "would not install: " with nothing after the colon, is the kind of
        // message that costs an evening; incus said why and it was being thrown
        // away.
        if (!operation.Succeeded && output.Length == 0 && operation.Err.Length > 0)
        {
            output.Append(operation.Err);
        }

        return new RunResult(operation.ReturnCode ?? (operation.Succeeded ? 0 : 1), output.ToString());
    }

    /// <summary>Run a shell fragment, which is what most provisioning is.</summary>
    /// <remarks>
    /// Recorded rather than interactive, because provisioning is where a pty
    /// that never closes actually happens — see <see cref="CaptureAsync(IncusApi, string, IReadOnlyList{string}, string?, string?, IReadOnlyDictionary{string, string}?, CancellationToken)"/>. The
    /// output arrives when the command does, so <paramref name="onLine"/> is told
    /// everything at the end rather than as it happens.
    /// </remarks>
    public static async Task<RunResult> ShellAsync(
        IncusApi api,
        string instance,
        string script,
        string? user = null,
        Action<string>? onLine = null,
        CancellationToken ct = default)
    {
        var result = await CaptureAsync(api, instance, ["sh", "-c", script], user, null, null, ct)
            .ConfigureAwait(false);

        if (onLine is not null)
        {
            foreach (var line in result.Text.Split('\n'))
            {
                onLine(line.TrimEnd('\r'));
            }
        }

        return result;
    }

    /// <summary>
    /// The environment a command gets when the caller does not say.
    /// </summary>
    /// <remarks>
    /// <c>TERM</c> because there is a pty on the other end and a program that
    /// finds no terminal type refuses to draw anything; the rest because a
    /// non-login exec inherits almost nothing.
    /// </remarks>
    /// <summary>A captured run, on whatever backend the instance is on.</summary>
    public static Task<RunResult> CaptureAsync(
        Backends.IExec backend,
        string instance,
        IReadOnlyList<string> command,
        string? user = null,
        string? cwd = null,
        IReadOnlyDictionary<string, string>? environment = null,
        CancellationToken ct = default) =>
        backend.CapturedAsync(
            instance,
            new Backends.ExecRequest
            {
                Command = AsUser(user, command),
                Cwd = cwd,
                Environment = EnvironmentFor(user, environment),
            },
            ct);

    /// <summary>A script under <c>sh</c>, on whatever backend the instance is on.</summary>
    public static async Task<RunResult> ShellAsync(
        Backends.IExec backend,
        string instance,
        string script,
        string? user = null,
        Action<string>? onLine = null,
        CancellationToken ct = default)
    {
        var result = await CaptureAsync(backend, instance, ["sh", "-c", script], user, null, null, ct)
            .ConfigureAwait(false);

        if (onLine is not null)
        {
            foreach (var line in result.Text.Split('\n'))
            {
                onLine(line.TrimEnd('\r'));
            }
        }

        return result;
    }

    public static readonly IReadOnlyDictionary<string, string> Defaults =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["TERM"] = "xterm-256color",
            ["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ["LANG"] = "C.UTF-8",
            ["DEBIAN_FRONTEND"] = "noninteractive",
        };
}

/// <summary>
/// The golden instance, and the snapshot every environment is copied from.
/// </summary>
/// <remarks>
/// <para>
/// This replaces the image build, and it is not the same shape. There is no
/// Dockerfile, no layer cache, and nothing to rebuild incrementally: an instance
/// is created, provisioned with exec and the files API, stopped, and
/// snapshotted. New environments are copies of that snapshot.
/// </para>
/// <para>
/// On a ZFS pool — which is what <c>apply_defaults</c> makes — a copy is a
/// clone: near-instant, and near-zero disk until something is written. That is
/// the mechanism that makes "another dev machine" cheap, and it is the whole
/// reason the storage backend is worth checking before anything is benchmarked.
/// </para>
/// <para>
/// Drift is handled by rebuilding golden and re-snapshotting, never by layering
/// onto it. A golden instance that has been patched in place is one nobody can
/// reproduce.
/// </para>
/// </remarks>
internal static class Golden
{
    /// <summary>The instance everything is copied from.</summary>
    public const string InstanceName = "envmux-golden";

    /// <summary>The snapshot on it that copies are taken of.</summary>
    public const string SnapshotName = "base";

    /// <summary>How a copy names its source.</summary>
    public static string Source => $"{InstanceName}/{SnapshotName}";

    /// <summary>Whether there is a golden snapshot to copy from.</summary>
    public static async Task<bool> ExistsAsync(IncusApi api, CancellationToken ct = default) =>
        (await api.SnapshotsAsync(InstanceName, ct).ConfigureAwait(false))
        .Contains(SnapshotName, StringComparer.Ordinal);

    /// <summary>
    /// Build the golden instance from scratch and snapshot it.
    /// </summary>
    /// <remarks>
    /// Destructive by design: an existing golden is removed rather than updated,
    /// because the point of it is that it is reproducible from this code and the
    /// image alone.
    /// </remarks>
    public static async Task BuildAsync(
        IncusApi api,
        HostConfig host,
        Action<string> report,
        CancellationToken ct = default)
    {
        if (await api.InstanceAsync(InstanceName, ct).ConfigureAwait(false) is { } existing)
        {
            report("removing the previous golden instance");

            if (existing.IsRunning)
            {
                await api.StopAsync(InstanceName, 10, ct).ConfigureAwait(false);
            }

            await api.DeleteAsync(InstanceName, ct).ConfigureAwait(false);
        }

        report($"creating {InstanceName} from {host.Image}");

        await api.CreateAsync(
            new InstancesPost
            {
                Name = InstanceName,
                Description = "envmux: the instance every session is copied from",
                Source = new InstanceSource
                {
                    Type = "image",
                    Alias = host.Image,
                    Protocol = "simplestreams",
                    Server = host.ImageServer,
                    Mode = "pull",
                },

                // On the host's network by name, like everything else. Left to
                // the default profile this is envmux0 on a VM envmux built and
                // whatever bridge the profile names on a daemon it did not —
                // which usually works, and makes the message below a guess.
                Devices = InstanceSpec.Attached(host),
                Start = true,
            },
            report,
            ct).ConfigureAwait(false);

        report("waiting for it to take an address");

        if (await api.AwaitAddressAsync(InstanceName, TimeSpan.FromSeconds(60), ct).ConfigureAwait(false) is null)
        {
            throw new IncusException(
                $"{InstanceName} started but never took an address on {host.Network} — " +
                "provisioning needs the network to fetch packages");
        }

        report("installing the toolchain");

        var provision = await Command.ShellAsync(api, InstanceName, Provision(), null, report, ct)
            .ConfigureAwait(false);

        if (!provision.Ok)
        {
            throw new IncusException($"provisioning {InstanceName} failed: {Tail(provision.Text)}");
        }

        report("installing the agent");

        var agent = await Command.ShellAsync(api, InstanceName, InstallAgent(), null, null, ct)
            .ConfigureAwait(false);

        if (agent.Ok)
        {
            report($"{agent.Text.Trim()} is in the image, for every account");
        }
        else
        {
            // Not fatal, and said plainly rather than buried: a session without
            // the agent is a session; a golden build that refused to finish
            // because a download failed is not.
            report($"could not install the agent, and the image is fine without it: {Tail(agent.Text)}");
        }

        // Checked rather than assumed, because everything downstream — every
        // task, every shell, every latched build — is a tmux invocation, and a
        // golden image without it produces "no such file or directory" from a
        // place that looks nothing like the cause.
        var check = await Command.CaptureAsync(api, InstanceName, [Latch.Multiplexer, "-V"], ct: ct)
            .ConfigureAwait(false);

        if (!check.Ok)
        {
            throw new IncusException(
                $"{Latch.Multiplexer} is not in the golden instance, and every exec goes through it");
        }

        report($"{check.Text.Trim()} is in the image");

        // Stopped before the snapshot: a snapshot of a running container is
        // either stateful — which needs CRIU and is not wanted — or a copy of a
        // filesystem mid-write.
        report("stopping it so the snapshot is clean");
        await api.StopAsync(InstanceName, 20, ct).ConfigureAwait(false);

        report($"snapshotting as '{SnapshotName}'");
        await api.SnapshotAsync(InstanceName, SnapshotName, ct).ConfigureAwait(false);

        report($"golden ready — copies of {Source} are what a session now costs");
    }

    /// <summary>
    /// Everything that has to be in an environment before envmux can use it.
    /// </summary>
    /// <remarks>
    /// Deliberately short. This is not a place to put a project's toolchain —
    /// that belongs in the project's own tasks, where it is declared, reviewed
    /// and changed with the project. What is here is what envmux itself depends
    /// on being present.
    /// </remarks>
    public static string Provision() =>
        new StringBuilder()
            .Line("set -eu")
            .Line("export DEBIAN_FRONTEND=noninteractive")
            .Line("apt-get update -qq")

            // tmux is the latch. openssh-server is how an editor attaches, since
            // there is no Dev Containers equivalent across a machine boundary.
            // The rest is what a session assumes a machine has.
            .Line("apt-get install -y -qq --no-install-recommends \\")
            .Line($"  {Latch.Multiplexer} openssh-server ca-certificates curl git sudo less rsync")
            .Line("apt-get clean")
            .Line("rm -rf /var/lib/apt/lists/*")

            // Sticky, so every account can write its own logs into it and none
            // can remove another's.
            .Line($"mkdir -p {Latch.LogDirectory}")
            .Line($"chmod 1777 {Latch.LogDirectory}")

            // A pty with no terminfo for what it claims to be draws nothing.
            .Line("mkdir -p /etc/skel")
            .Line("printf 'export TERM=${TERM:-xterm-256color}\\n' >> /etc/skel/.bashrc")

            .Line("systemctl enable ssh >/dev/null 2>&1 || true")
            .ToString();

    /// <summary>Where the agent binary lives, for every account rather than one.</summary>
    public const string AgentDirectory = "/opt/claude";

    /// <summary>
    /// Put Claude Code in the image, once, for everybody.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The odd one out in an image that otherwise holds only what envmux itself
    /// needs, and it earns the exception: the whole promise of carrying
    /// <c>~/.claude</c> across is that the agent arrives signed in, and a
    /// signed-in agent with no binary is a promise that is not kept. Installing
    /// it here rather than per session means it costs nothing — copies of this
    /// snapshot are clones.
    /// </para>
    /// <para>
    /// The installer puts everything under <c>$HOME</c> and refuses to run under
    /// sudo, precisely so it does not land in root's home and be missing from
    /// everyone else's. Running it as plain root is allowed and is what happens
    /// here, and then the one thing it produced — a self-contained native binary
    /// behind a versioned symlink — is copied somewhere every account can reach
    /// and root's copy is removed. Each account still keeps its own
    /// <c>~/.claude</c>, which is the part that is personal.
    /// </para>
    /// <para>
    /// Best-effort. A golden build must not fail because a download did, so this
    /// reports and moves on: a session without the agent is a session, and a
    /// session that never started is not.
    /// </para>
    /// </remarks>
    public static string InstallAgent() =>
        new StringBuilder()
            .Line("set -eu")
            .Line("curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh")
            .Line("bash /tmp/claude-install.sh stable >/dev/null 2>&1")

            // The installed name is a symlink to a versioned file; the binary is
            // what is wanted, so that removing root's copy does not break it.
            .Line("binary=$(readlink -f /root/.local/bin/claude)")
            .Line($"mkdir -p {AgentDirectory}")
            .Line($"cp \"$binary\" {AgentDirectory}/claude")
            .Line($"chmod 0755 {AgentDirectory}/claude")
            .Line($"ln -sfn {AgentDirectory}/claude /usr/local/bin/claude")

            // Root's own copy and state go: this image is copied for every
            // session, and root's signed-in agent is not anybody's.
            .Line("rm -rf /root/.local/share/claude /root/.local/bin/claude /root/.claude /tmp/claude-install.sh")
            .Line("claude --version")
            .ToString();

    private static string Tail(string output)
    {
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        return string.Join(" | ", lines.TakeLast(3));
    }
}
