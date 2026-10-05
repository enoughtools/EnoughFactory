using System.Diagnostics;
using System.Globalization;
using System.Net;

namespace Envmux.Socks;

/// <summary>Ask macOS which process owns the client socket, then walk its parents.</summary>
/// <remarks>
/// lsof uses libproc and ships with macOS. Its field output avoids parsing a
/// display table, and the complete directed tuple distinguishes the browser's
/// socket from our accepted socket. Failure denies access; loopback alone is
/// never proof that a connection belongs to the browser we launched.
/// </remarks>
internal static class MacConnectionOwner
{
    public static async Task<int?> FindAsync(IPEndPoint client, int listenerPort, CancellationToken ct)
    {
        var output = await ReadAsync("/usr/sbin/lsof",
            ["-nP", $"-iTCP:{client.Port.ToString(CultureInfo.InvariantCulture)}", "-Fpn"], ct).ConfigureAwait(false);
        return ParseOwner(output, client, listenerPort);
    }

    public static int? ParseOwner(string output, IPEndPoint client, int listenerPort)
    {
        var address = client.Address.IsIPv4MappedToIPv6 ? client.Address.MapToIPv4() : client.Address;
        var tuple = string.Create(CultureInfo.InvariantCulture,
            $"{address}:{client.Port}->127.0.0.1:{listenerPort}");
        int? pid = null;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line[0] == 'p')
            {
                pid = int.TryParse(line.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
                    && parsed > 0 ? parsed : null;
            }
            else if (line[0] == 'n' && string.Equals(line[1..], tuple, StringComparison.Ordinal))
            {
                return pid;
            }
        }

        return null;
    }

    public static async Task<int?> ParentAsync(int pid, CancellationToken ct)
    {
        var output = await ReadAsync("/bin/ps", ["-p", pid.ToString(CultureInfo.InvariantCulture), "-o", "ppid="], ct)
            .ConfigureAwait(false);
        return int.TryParse(output.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var parent) && parent > 0
            ? parent : null;
    }

    private static async Task<string> ReadAsync(string executable, string[] arguments, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var process = new System.Diagnostics.Process { StartInfo = start };
        try
        {
            process.Start();
            var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
            var error = process.StandardError.ReadToEndAsync(deadline.Token);
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);
            await error.ConfigureAwait(false);
            var result = await output.ConfigureAwait(false);
            return process.ExitCode == 0 ? result : "";
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill();
            }

            ct.ThrowIfCancellationRequested();
            return "";
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return "";
        }
    }
}
