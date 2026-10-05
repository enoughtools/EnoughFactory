using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Envmux.Process;

/// <summary>
/// Opening a URL in whatever the host uses for URLs.
/// </summary>
/// <remarks>
/// Each platform has exactly one way to say "open this in whatever handles it"
/// and no two of them are the same. Here rather than in a view, because both
/// UIs have an open-this-route key and the three-way switch is not a thing
/// worth having two copies of.
/// </remarks>
internal static class Browser
{
    /// <summary>Open it, saying why not rather than throwing.</summary>
    /// <remarks>
    /// A browser that will not start is worth a line in the log and nothing
    /// more — the route is still there, and the URL is on screen to be copied.
    /// </remarks>
    public static bool TryOpen(string url, out string? why)
    {
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                System.Diagnostics.Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                System.Diagnostics.Process.Start("open", url);
            }
            else
            {
                System.Diagnostics.Process.Start("xdg-open", url);
            }

            why = null;
            return true;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            why = e.Message;
            return false;
        }
    }
}
