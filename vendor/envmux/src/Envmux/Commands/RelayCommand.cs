using System.Globalization;

using Envmux.Backends;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Socks;

namespace Envmux.Commands;

/// <summary>
/// <c>envmux relay &lt;instance&gt; &lt;port&gt;</c>: this process's stdin and
/// stdout, joined to a TCP port inside an instance.
/// </summary>
/// <remarks>
/// <para>
/// What ssh runs as the <c>ProxyCommand</c> of the <c>Host *.&lt;zone&gt;</c>
/// block <c>envmux ssh</c> writes. A session's name under the zone used to
/// resolve, because the workstation had a route to the range and an NRPT rule
/// for the zone; it does not any more, and this is what makes the name still
/// work for ssh — and so for the editor's Remote-SSH attach. The connection is
/// the same one the session's browser proxy uses
/// (<see cref="InstanceRelay"/>): an exec in the instance, dialling the port
/// from inside, carried over the host's API. Nothing on the workstation routes
/// or resolves anything.
/// </para>
/// <para>
/// Not in the usage, because nobody types it: ssh does, with <c>%h</c> and
/// <c>%p</c>. The first argument is the alias as ssh has it —
/// <c>myproj-feat-login.envmux</c> — and the instance is everything before the
/// first dot. That is safe because an instance name is a slug and has no dot in
/// it, and it means the zone does not have to be known here: a block covering
/// two zones hands over two shapes of alias and both come out right.
/// </para>
/// <para>
/// Stdout is the ssh channel, so nothing here writes to it but the bytes from
/// the instance. Everything said to a person goes to stderr, which ssh shows.
/// </para>
/// </remarks>
internal static class RelayCommand
{
    /// <summary>
    /// Where the port is dialled from inside the instance: IPv4 loopback first,
    /// then IPv6, because sshd listens on both and a server that bound only one
    /// should still be found.
    /// </summary>
    private static readonly string[] Loopback = ["127.0.0.1", "::1"];

    public static async Task<int> RunAsync(IReadOnlyList<string> args, CancellationToken ct = default)
    {
        BackendKind? requested = null;
        if (args.Count == 4 && args[0] == "--backend")
        {
            requested = BackendCatalog.Parse(args[1]);
            if (requested is null)
            {
                Console.Error.WriteLine("envmux: --backend is incus or docker");
                return 2;
            }

            args = [args[2], args[3]];
        }

        if (args.Count != 2 ||
            !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out var port) ||
            port is < 1 or > 65535)
        {
            Console.Error.WriteLine(
                $"envmux: `{CommandName.Current} relay <instance>[.<zone>] <port>` — what ssh runs as the " +
                $"ProxyCommand `{CommandName.Current} ssh` writes; it is not for typing.");
            return 2;
        }

        var instance = Instance(args[0]);
        var config = HostConfig.Load();

        await using var backend = BackendCatalog.Open(requested, config);

        // As root, deliberately. The exec only opens a TCP connection to the
        // instance's own loopback, and which account opens it changes nothing
        // about what answers — sshd does its own authentication on the bytes
        // that follow. The session's account is known only to the session that
        // made it, and root is in every instance. An empty account is what
        // Command.AsUser reads as root, with no runuser in between.
        await using var stream = await backend.Exec
            .DialAsync(instance, "", Loopback, port, ct)
            .ConfigureAwait(false);

        if (stream is null)
        {
            Console.Error.WriteLine(
                $"envmux: nothing answers on port {port.ToString(CultureInfo.InvariantCulture)} in {instance}. " +
                $"The instance is stopped, or nothing in it listens there yet — `{CommandName.Current} host status` " +
                "lists the instances and their state.");
            return 1;
        }

        await PumpAsync(stream, ct).ConfigureAwait(false);
        return 0;
    }

    /// <summary>The instance an ssh alias names: the label before the zone.</summary>
    /// <remarks>
    /// Lowercased because ssh lowercases the host it was given before
    /// substituting <c>%h</c>, and an alias typed with a capital should reach
    /// the same instance the block was written for.
    /// </remarks>
    internal static string Instance(string alias) =>
        alias.Trim().Split('.')[0].ToLowerInvariant();

    /// <summary>
    /// Copy stdin into the instance and the instance onto stdout, until either
    /// side is done.
    /// </summary>
    /// <remarks>
    /// Stdin closing is ssh hanging up, and is the normal end. The instance's
    /// side closing — sshd gone, the instance stopped — has to end it too, or
    /// ssh would sit on a connection that can never say anything again. Either
    /// one finishing returns; the process then exits, which is what releases a
    /// stdin read that cannot be cancelled.
    /// </remarks>
    private static async Task PumpAsync(Stream instance, CancellationToken ct)
    {
        using var done = CancellationTokenSource.CreateLinkedTokenSource(ct);

        await using var stdin = Console.OpenStandardInput();
        await using var stdout = Console.OpenStandardOutput();

        var inbound = Task.Run(() => instance.CopyToAsync(stdout, done.Token), done.Token);
        var outbound = Task.Run(() => stdin.CopyToAsync(instance, done.Token), done.Token);

        try
        {
            await await Task.WhenAny(inbound, outbound).ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or OperationCanceledException)
        {
            // The far side went away mid-copy, or ssh did. Both are the end of
            // the connection rather than a failure of the relay.
        }
        finally
        {
            await done.CancelAsync().ConfigureAwait(false);
        }
    }
}
