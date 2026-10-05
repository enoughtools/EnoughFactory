using System.Globalization;
using System.Text.Json;

namespace Envmux.Host.Windows;

/// <summary>What the VM currently has on screen.</summary>
/// <param name="Width">Pixels across, as the guest set the mode.</param>
/// <param name="Height">Pixels down.</param>
/// <param name="Pixels">8-bit RGB triples, top row first.</param>
internal sealed record Screen(int Width, int Height, byte[] Pixels)
{
    /// <summary>The pixel at a point, as a triple.</summary>
    public (byte R, byte G, byte B) At(int x, int y)
    {
        var i = ((y * Width) + x) * 3;
        return (Pixels[i], Pixels[i + 1], Pixels[i + 2]);
    }

    /// <summary>This screen as a PNG.</summary>
    public byte[] ToPng() => Png.Encode(Pixels, Width, Height);
}

/// <summary>
/// Reading the screen of a machine that has no other way to be asked.
/// </summary>
/// <remarks>
/// <para>
/// IncusOS has no shell and no console login, so when something goes wrong
/// before the API is up there is genuinely nothing to interrogate — the
/// documentation's answer is "look at it in Hyper-V Manager". This is that,
/// without Hyper-V Manager: Hyper-V will hand out the guest's framebuffer over
/// WMI, and a picture of the screen is a diagnostic a person can act on.
/// </para>
/// <para>
/// It is also the only signal available for one specific moment. The installer
/// finishes in seconds and then <em>waits</em>, with the machine still running
/// and nothing listening on any port — so neither of the two things envmux can
/// normally poll has changed, and the only place the news exists is on the
/// screen.
/// </para>
/// <para>
/// Through PowerShell like everything else here. The alternative is
/// <c>System.Management</c>, which is a Windows-only package, for four WMI calls
/// this can already make.
/// </para>
/// </remarks>
internal static class Framebuffer
{
    /// <summary>
    /// Grab the guest's screen, or null when there is nothing to grab.
    /// </summary>
    /// <remarks>
    /// Null rather than an exception for the ordinary cases: a VM that is off
    /// has no video head, and one that has only just started may not have set a
    /// mode yet. Both are "ask again in a second" rather than failures.
    /// </remarks>
    public static async Task<Screen?> CaptureAsync(string vmName, CancellationToken ct = default)
    {
        var payload = Path.Combine(Path.GetTempPath(), $"envmux-screen-{Guid.NewGuid():N}.bin");

        try
        {
            var json = await Powershell.JsonAsync(
                """
                $ns = 'root\virtualization\v2'

                $vm = Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem `
                                      -Filter "ElementName='$Name'" -ErrorAction SilentlyContinue
                if (-not $vm) { '{"ok":false,"why":"no such VM"}'; exit 0 }

                # The realized settings, not the pending ones: a VM that has been
                # edited has both, and the thumbnail belongs to what is running.
                $vssd = $vm | Get-CimAssociatedInstance -ResultClassName Msvm_VirtualSystemSettingData |
                        Where-Object VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized'

                $head = $vm | Get-CimAssociatedInstance -ResultClassName Msvm_VideoHead -ErrorAction SilentlyContinue
                if (-not $head) { '{"ok":false,"why":"no video head — is it running?"}'; exit 0 }

                $w = [uint16]($head | Select-Object -First 1).CurrentHorizontalResolution
                $h = [uint16]($head | Select-Object -First 1).CurrentVerticalResolution
                if (-not $w -or -not $h) { '{"ok":false,"why":"no video mode set yet"}'; exit 0 }

                $svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService

                $res = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
                    TargetSystem = [CimInstance]$vssd
                    WidthPixels  = $w
                    HeightPixels = $h
                }

                if ($res.ReturnValue -ne 0 -or -not $res.ImageData) {
                    '{"ok":false,"why":"the host would not give up a thumbnail"}'; exit 0
                }

                # To a file rather than back through stdout: a full screen is a
                # megabyte and a half, and base64 of that is one very long line
                # for a pipe to carry.
                [IO.File]::WriteAllBytes($Payload, $res.ImageData)

                [pscustomobject]@{ ok = $true; width = [int]$w; height = [int]$h } | ConvertTo-Json -Compress
                """,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["Name"] = vmName,
                    ["Payload"] = payload,
                },
                ct).ConfigureAwait(false);

            if (json.ValueKind != JsonValueKind.Object ||
                !json.TryGetProperty("ok", out var ok) ||
                ok.ValueKind != JsonValueKind.True)
            {
                return null;
            }

            var width = json.GetProperty("width").GetInt32();
            var height = json.GetProperty("height").GetInt32();

            var raw = await File.ReadAllBytesAsync(payload, ct).ConfigureAwait(false);

            return new Screen(width, height, Png.FromRgb565(raw, width, height));
        }
        catch (Exception e) when (e is PowershellException or IOException or ArgumentException
                                      or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
        finally
        {
            try
            {
                File.Delete(payload);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A megabyte in the temp directory. Not worth a second failure.
            }
        }
    }

    /// <summary>
    /// Grab the screen and write it out, for a person to look at.
    /// </summary>
    /// <returns>Where it was written, or null when there was nothing to capture.</returns>
    public static async Task<string?> SaveAsync(string vmName, string path, CancellationToken ct = default)
    {
        if (await CaptureAsync(vmName, ct).ConfigureAwait(false) is not { } screen)
        {
            return null;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        await File.WriteAllBytesAsync(path, screen.ToPng(), ct).ConfigureAwait(false);

        return path;
    }

    /// <summary>
    /// A cheap value that changes when the screen does.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For telling "still working" from "finished and waiting", which is the
    /// only question the installer's screen has to answer. A running installer
    /// redraws; a finished one has stopped.
    /// </para>
    /// <para>
    /// Sampled on a grid rather than hashed whole, so that a blinking cursor —
    /// one cell, once a second — does not read as activity. Two identical
    /// samples a few seconds apart is a screen that has settled.
    /// </para>
    /// <para>
    /// The top of the screen is skipped, and that is not a nicety. IncusOS draws
    /// a status bar there reading
    /// <c>localhost | IncusOS 202608201218 | 2026-08-21 09:35 UTC</c>, and the
    /// clock in it ticks over every minute. Sampling it would mean the screen
    /// could never be still for longer than sixty seconds, which is the one
    /// thing this is measuring.
    /// </para>
    /// </remarks>
    public static long Signature(Screen screen)
    {
        const int Grid = 32;

        // Enough to clear a line of text at any mode the guest is likely to
        // pick, without eating into a screen that is mostly log.
        var top = screen.Height / 20;
        var span = screen.Height - 1 - top;

        unchecked
        {
            long hash = 17;

            for (var y = 0; y < Grid; y++)
            {
                for (var x = 0; x < Grid; x++)
                {
                    var (r, g, b) = screen.At(
                        x * (screen.Width - 1) / (Grid - 1),
                        top + (y * span / (Grid - 1)));

                    hash = (hash * 31) + r;
                    hash = (hash * 31) + g;
                    hash = (hash * 31) + b;
                }
            }

            return hash;
        }
    }

    /// <summary>How this reads in a log line.</summary>
    public static string Describe(Screen screen) =>
        $"{screen.Width.ToString(CultureInfo.InvariantCulture)}x" +
        $"{screen.Height.ToString(CultureInfo.InvariantCulture)}";
}
