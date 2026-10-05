using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;

namespace Envmux.Live;

/// <summary>
/// The workstation's git credentials, answered one host at a time, when asked.
/// </summary>
/// <remarks>
/// <para>
/// envmux already carries git credentials in: <c>GitCredentials</c> asks
/// <c>git credential fill</c> on the workstation at session start and writes
/// the answer into the instance as a <c>store</c> file. That is a copy, with
/// the copy's problem — a GitHub token issued through Git Credential Manager is
/// an OAuth token with an expiry, and a session that outlives it is a session
/// whose <c>git push</c> fails with a 401 that nothing inside can fix.
/// </para>
/// <para>
/// This is the live form. The instance has a credential helper; the helper reads
/// a file; the file is virtual, on the same mount as everything else, and
/// reading it is what runs <c>git credential fill</c> here, against whatever
/// helper this workstation has — Git Credential Manager on Windows, a keychain
/// on macOS, libsecret on Linux. Same four lines back regardless, which is why
/// this asks git rather than reaching into any of those stores itself.
/// </para>
/// <para>
/// A file rather than an HTTP call from the helper, deliberately. A call would
/// need a key the helper can read, and the helper runs as the session user, so
/// every task in the instance could read it too. The mount is already per task
/// and already keyed, and its key sits where the session user cannot get at it.
/// Putting the credential behind the mount buys all of that for nothing.
/// </para>
/// <para>
/// Read-only, and by host allowlist. <c>store</c> and <c>erase</c> are never
/// forwarded — a container does not get to change what this workstation is
/// signed in as — and the hosts are the ones the repository's remotes point at,
/// passed in by envmux, not every host the helper happens to know.
/// </para>
/// </remarks>
internal sealed class GitVault(IReadOnlyList<string> hosts)
{
    /// <summary>
    /// How long one answer is reused before git is asked again.
    /// </summary>
    /// <remarks>
    /// Long enough that a <c>PROPFIND</c> followed by a <c>GET</c> — which is
    /// every read through rclone — sees one consistent answer with one length.
    /// Short enough that a token the helper rotated is picked up inside a
    /// minute. Longer than the client's directory cache, so the size a listing
    /// reported is still the size a read returns.
    /// </remarks>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    private readonly ConcurrentDictionary<string, (byte[] Bytes, DateTimeOffset At)> _cache =
        new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<string> Hosts => hosts;

    public bool Knows(string host) => hosts.Contains(host, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The credential for one host, as the lines <c>git credential</c> speaks,
    /// or null if the workstation's helper has none.
    /// </summary>
    public async Task<byte[]?> GetAsync(string host, CancellationToken ct)
    {
        if (!Knows(host))
        {
            return null;
        }

        if (_cache.TryGetValue(host, out var cached) && DateTimeOffset.UtcNow - cached.At < Ttl)
        {
            return cached.Bytes;
        }

        var filled = await FillAsync(host, ct).ConfigureAwait(false);

        if (filled is not null)
        {
            _cache[host] = (filled, DateTimeOffset.UtcNow);
        }

        return filled;
    }

    /// <summary>
    /// <c>git credential fill</c>, told not to ask anybody anything.
    /// </summary>
    /// <remarks>
    /// <c>GIT_TERMINAL_PROMPT=0</c> stops git itself; <c>GCM_INTERACTIVE=never</c>
    /// stops Git Credential Manager opening a browser on a workstation whose
    /// owner is not looking at it because a container asked. A host with no
    /// stored credential is an empty answer, not a dialog.
    /// </remarks>
    private static async Task<byte[]?> FillAsync(string host, CancellationToken ct)
    {
        var start = new ProcessStartInfo("git")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        start.ArgumentList.Add("credential");
        start.ArgumentList.Add("fill");
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GCM_INTERACTIVE"] = "never";

        using var process = new Process { StartInfo = start };

        try
        {
            process.Start();
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return null;
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(Timeout);

        try
        {
            await process.StandardInput.WriteAsync($"protocol=https\nhost={host}\n\n").ConfigureAwait(false);
            process.StandardInput.Close();

            var output = await process.StandardOutput.ReadToEndAsync(deadline.Token).ConfigureAwait(false);
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);

            // Only a complete answer is an answer. GCM with nothing stored exits
            // zero and echoes the question back without a password.
            if (process.ExitCode != 0 || !output.Contains("\npassword=", StringComparison.Ordinal) &&
                                          !output.StartsWith("password=", StringComparison.Ordinal))
            {
                return null;
            }

            return Encoding.UTF8.GetBytes(output.Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Already gone.
            }

            return null;
        }
    }
}
