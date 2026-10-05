using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Envmux.Socks;

/// <summary>The browsers envmux knows how to point at a SOCKS port.</summary>
internal enum BrowserKind
{
    Chrome,
    Firefox,
    Edge,
}

/// <summary>A browser found on this machine.</summary>
internal sealed record InstalledBrowser(BrowserKind Kind, string Path)
{
    public string Name => Kind.ToString().ToLowerInvariant();

    /// <summary>Whether it takes Chromium's switches.</summary>
    public bool IsChromium => Kind is BrowserKind.Chrome or BrowserKind.Edge;
}

/// <summary>A browser that could not be found or would not start.</summary>
internal sealed class BrowserException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Finding a browser, and starting it on its own profile with the session's
/// SOCKS port as its only way out.
/// </summary>
/// <remarks>
/// <para>
/// Its own profile per session and per browser, for two reasons. A browser
/// already running on the default profile would take the command line, open a
/// tab in itself, and ignore every switch on it — the proxy included. And every
/// session's app lives at <c>localhost:3000</c>: shared cookies and storage
/// between two of them would be one app's login in the other's tab.
/// </para>
/// <para>
/// Chromium bypasses the proxy for loopback unless told not to, silently; so
/// does Firefox. <c>--proxy-bypass-list=&lt;-loopback&gt;</c> and
/// <c>network.proxy.allow_hijacking_localhost</c> are what make
/// <c>localhost</c> the instance, and the pure builders below are where the
/// tests pin them.
/// </para>
/// </remarks>
internal static class BrowserLaunch
{
    /// <summary>The order the key tries browsers in when none was named.</summary>
    public static readonly IReadOnlyList<BrowserKind> Preference = [BrowserKind.Chrome, BrowserKind.Firefox, BrowserKind.Edge];

    /// <summary>Where each browser installs itself, per machine and per user.</summary>
    /// <remarks>
    /// Mac app bundles are launched through their executable so the proxy can
    /// identify the browser process and its descendants.
    /// </remarks>
    public static IReadOnlyList<string> Candidates(BrowserKind kind)
    {
        if (OperatingSystem.IsMacOS())
        {
            var relativeMac = kind switch
            {
                BrowserKind.Chrome => "Google Chrome.app/Contents/MacOS/Google Chrome",
                BrowserKind.Firefox => "Firefox.app/Contents/MacOS/firefox",
                _ => "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            };
            return [Path.Combine("/Applications", relativeMac),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Applications", relativeMac)];
        }

        if (!OperatingSystem.IsWindows())
        {
            return [];
        }

        var programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programsX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        var relative = kind switch
        {
            BrowserKind.Chrome => Path.Combine("Google", "Chrome", "Application", "chrome.exe"),
            BrowserKind.Firefox => Path.Combine("Mozilla Firefox", "firefox.exe"),
            _ => Path.Combine("Microsoft", "Edge", "Application", "msedge.exe"),
        };

        return [.. new[] { programs, programsX86, local }
            .Where(root => root.Length > 0)
            .Select(root => Path.Combine(root, relative))];
    }

    /// <summary>Every browser installed here, in <see cref="Preference"/> order.</summary>
    public static IReadOnlyList<InstalledBrowser> Discover() =>
        [.. Preference
            .Select(kind => Candidates(kind).FirstOrDefault(File.Exists) is { } path
                ? new InstalledBrowser(kind, path)
                : null)
            .OfType<InstalledBrowser>()];

    /// <summary>
    /// The browser to launch: the one named, a path to one, or the first found.
    /// </summary>
    /// <exception cref="BrowserException">What was asked for is not here, or nothing is.</exception>
    public static InstalledBrowser Choose(string? use, IReadOnlyList<InstalledBrowser> found)
    {
        if (string.IsNullOrWhiteSpace(use))
        {
            return found.Count > 0
                ? found[0]
                : throw new BrowserException(
                    OperatingSystem.IsWindows()
                        ? "no Chrome, Firefox or Edge found on this machine"
                        : "launching a browser on the session's proxy is Windows-only so far");
        }

        if (Enum.TryParse<BrowserKind>(use, ignoreCase: true, out var kind) && Enum.IsDefined(kind))
        {
            return found.FirstOrDefault(b => b.Kind == kind)
                   ?? throw new BrowserException($"{use} is not installed here (looked in {string.Join(", ", Candidates(kind))})");
        }

        if (File.Exists(use) && KindOf(use) is { } byName)
        {
            return new InstalledBrowser(byName, Path.GetFullPath(use));
        }

        throw new BrowserException(
            $"'{use}' is not chrome, firefox, edge or a path to one of them");
    }

    /// <summary>Which browser an executable is, by its file name.</summary>
    public static BrowserKind? KindOf(string path) =>
        Path.GetFileNameWithoutExtension(path.Replace('\\', '/')).ToLowerInvariant() switch
        {
            "chrome" or "chromium" or "google chrome" => BrowserKind.Chrome,
            "firefox" => BrowserKind.Firefox,
            "msedge" or "microsoft edge" => BrowserKind.Edge,
            _ => null,
        };

    /// <summary>Chromium's switches: its own profile, the proxy, loopback through it, and its name.</summary>
    public static IReadOnlyList<string> ChromiumArguments(int port, string profile, string url, string name) =>
    [
        $"--user-data-dir={profile}",

        // What the window is called — in its title, the taskbar and Alt-Tab —
        // in place of the page's title: the "Name window" Chrome's own menu
        // sets. The profile name seeded into Local State shows nowhere on a
        // single unsigned profile (the button says "sign in"), so this is the
        // label that is actually seen. A switch, not an extension; Chrome 153
        // honoured it.
        $"--window-name={name}",
        $"--proxy-server=socks5://{Portal.PortalPlan.Loopback}:{port.ToString(CultureInfo.InvariantCulture)}",

        // Without this Chromium sends localhost, 127/8 and [::1] straight to
        // this machine whatever the proxy says.
        "--proxy-bypass-list=<-loopback>",
        "--no-first-run",
        "--no-default-browser-check",
        url,
    ];

    /// <summary>
    /// Firefox's preferences, written as the profile's <c>user.js</c>.
    /// </summary>
    /// <remarks>
    /// <c>socks_remote_dns</c> so a name is resolved where it is dialled — in
    /// the instance for <c>localhost</c>, here for everything else — and
    /// <c>allow_hijacking_localhost</c> so loopback goes through at all.
    /// </remarks>
    public static string FirefoxPreferences(int port)
    {
        var preferences = new (string Name, string Value)[]
        {
            ("network.proxy.type", "1"),
            ("network.proxy.socks", $"\"{Portal.PortalPlan.Loopback}\""),
            ("network.proxy.socks_port", port.ToString(CultureInfo.InvariantCulture)),
            ("network.proxy.socks_version", "5"),
            ("network.proxy.socks_remote_dns", "true"),
            ("network.proxy.allow_hijacking_localhost", "true"),
            ("network.proxy.no_proxies_on", "\"\""),
            ("browser.shell.checkDefaultBrowser", "false"),
            ("browser.aboutwelcome.enabled", "false"),
            ("datareporting.policy.dataSubmissionPolicyBypassNotification", "true"),
        };

        var text = new StringBuilder();

        foreach (var (name, value) in preferences)
        {
            text.Line($"user_pref(\"{name}\", {value});");
        }

        return text.ToString();
    }

    public static IReadOnlyList<string> FirefoxArguments(string profile, string url) =>
        ["-profile", profile, url];

    /// <summary>
    /// Colours a session's browser can be, as Chrome takes them: opaque ARGB.
    /// </summary>
    /// <remarks>
    /// Material 600s, far enough apart that two windows side by side are told
    /// apart at a glance, and each dark enough for Chrome to build a readable
    /// palette from. Teal first, because it is the one that was tried and liked.
    /// </remarks>
    public static readonly IReadOnlyList<uint> Palette =
    [
        0xFF00897B, // teal
        0xFF1E88E5, // blue
        0xFF8E24AA, // purple
        0xFFF4511E, // deep orange
        0xFF43A047, // green
        0xFFD81B60, // pink
        0xFF3949AB, // indigo
        0xFFFFB300, // amber
        0xFF00ACC1, // cyan
        0xFF6D4C41, // brown
    ];

    /// <summary>
    /// The colour a session's browser is, unless <c>browser.color</c> says otherwise.
    /// </summary>
    /// <remarks>
    /// FNV-1a over the instance name rather than <see cref="string.GetHashCode()"/>,
    /// which is randomised per process: a session has to be the same colour
    /// every time it is started, or the colour means nothing.
    /// </remarks>
    public static uint ColourFor(string instance)
    {
        var hash = 2166136261u;

        foreach (var b in Encoding.UTF8.GetBytes(instance))
        {
            hash = unchecked((hash ^ b) * 16777619u);
        }

        return Palette[(int)(hash % (uint)Palette.Count)];
    }

    /// <summary>
    /// Read a colour written as <c>#rrggbb</c>, or null when it is not one.
    /// </summary>
    public static uint? ParseColour(string text) =>
        text.Length == 7 && text[0] == '#' &&
        uint.TryParse(text.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb)
            ? 0xFF000000 | rgb
            : null;

    /// <summary>
    /// A new Chromium profile's first state: its name, and its colour.
    /// </summary>
    /// <remarks>
    /// <para>
    /// No extension and no switch, because neither survives: branded Chrome
    /// loads no extension from a command line since 137, and there is no switch
    /// for a theme. What survives is state. <c>browser.theme.user_color2</c> in
    /// the profile's <c>Preferences</c> is what "Customize Chrome" writes when a
    /// colour is picked, and <c>profile.info_cache</c> in <c>Local State</c> is
    /// the name on the profile button. Chrome 153 read both and kept them
    /// (checked by launching on a seeded profile and reading them back).
    /// </para>
    /// <para>
    /// Written only into a profile that does not exist yet. Chrome owns the
    /// files once it has run, and rewrites them on exit; a person who changes the
    /// colour afterwards keeps their change.
    /// </para>
    /// </remarks>
    public static void SeedChromiumProfile(string profile, string name, uint colour)
    {
        if (File.Exists(Path.Combine(profile, "Local State")))
        {
            return;
        }

        Directory.CreateDirectory(Path.Combine(profile, "Default"));

        var preferences = new System.Text.Json.Nodes.JsonObject
        {
            ["browser"] = new System.Text.Json.Nodes.JsonObject
            {
                ["theme"] = new System.Text.Json.Nodes.JsonObject
                {
                    // Chrome stores the colour as a signed 32-bit ARGB.
                    ["user_color2"] = unchecked((int)colour),
                    ["color_variant2"] = 1,
                },
            },
            ["profile"] = new System.Text.Json.Nodes.JsonObject { ["name"] = name },
        };

        var localState = new System.Text.Json.Nodes.JsonObject
        {
            ["profile"] = new System.Text.Json.Nodes.JsonObject
            {
                ["info_cache"] = new System.Text.Json.Nodes.JsonObject
                {
                    ["Default"] = new System.Text.Json.Nodes.JsonObject
                    {
                        ["name"] = name,
                        ["is_using_default_name"] = false,
                    },
                },
            },
        };

        File.WriteAllText(Path.Combine(profile, "Default", "Preferences"), preferences.ToJsonString());
        File.WriteAllText(Path.Combine(profile, "Local State"), localState.ToJsonString());
    }

    /// <summary>
    /// Where a browser opened on the session starts.
    /// </summary>
    /// <remarks>
    /// <c>browser.open</c> when it names a route or is a URL, otherwise the first
    /// web route by name. A route opens on <c>localhost</c>, which in that
    /// browser is the instance, and keeps the path its task printed, so a server
    /// that announces <c>/app/</c> opens there.
    /// </remarks>
    public static string StartUrl(string? open, IReadOnlyList<Routing.RoutedEndpoint> routes)
    {
        if (open is not null)
        {
            return routes.FirstOrDefault(r => r.Name.Equals(open, StringComparison.OrdinalIgnoreCase)) is { } named
                ? LocalUrl(named)
                : AsUrl(open);
        }

        return routes.FirstOrDefault(r => r.Scheme is Config.RouteConfig.Http or Config.RouteConfig.Https) is { } first
            ? LocalUrl(first)
            : "about:blank";
    }

    /// <summary>
    /// Whether <paramref name="open"/> reads as a route's name rather than a
    /// URL: no scheme, port, path or dot.
    /// </summary>
    public static bool IsRouteName(string open) =>
        open.IndexOfAny([':', '/', '.']) < 0;

    /// <summary>What somebody typed, as a URL: <c>localhost:5173/admin</c> gets an http scheme.</summary>
    public static string AsUrl(string typed) =>
        typed.Contains("://", StringComparison.Ordinal) || typed.StartsWith("about:", StringComparison.Ordinal)
            ? typed
            : "http://" + typed;

    private static string LocalUrl(Routing.RoutedEndpoint route) =>
        route.Pinned is { } pinned
            ? Routing.PinnedUrl.Rewrite(pinned, "localhost")
            : $"{route.Scheme}://localhost:{route.Port.ToString(CultureInfo.InvariantCulture)}/";

    /// <summary>
    /// Start the browser on the session's port, and return the process to be
    /// recognised by.
    /// </summary>
    /// <remarks>
    /// A browser that is already open on this profile takes the URL into a new
    /// tab and exits at once; the process returned is then that short-lived
    /// one, and the window that matters is the one launched before, which is
    /// already known.
    /// </remarks>
    /// <exception cref="BrowserException">It would not start.</exception>
    public static System.Diagnostics.Process Start(
        InstalledBrowser browser, int port, string profile, string url, string name, uint colour)
    {
        Directory.CreateDirectory(profile);

        if (browser.IsChromium)
        {
            SeedChromiumProfile(profile, name, colour);
        }

        if (browser.Kind == BrowserKind.Firefox)
        {
            File.WriteAllText(Path.Combine(profile, "user.js"), FirefoxPreferences(port));
        }

        var start = new ProcessStartInfo(browser.Path) { UseShellExecute = false };

        foreach (var argument in browser.IsChromium
                     ? ChromiumArguments(port, profile, url, name)
                     : FirefoxArguments(profile, url))
        {
            start.ArgumentList.Add(argument);
        }

        try
        {
            return System.Diagnostics.Process.Start(start)
                   ?? throw new BrowserException($"{browser.Name} did not start");
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            throw new BrowserException($"{browser.Name} would not start: {e.Message}", e);
        }
    }

    /// <summary>
    /// Where a session keeps a browser's profile.
    /// </summary>
    /// <remarks>
    /// Under envmux's own directory and named for the instance, so a restarted
    /// session gets its logins back, and <c>ENVMUX_HOME</c> moves it with
    /// everything else.
    /// </remarks>
    public static string ProfileDirectory(string instance, BrowserKind kind) =>
        Path.Combine(Host.HostConfig.Directory, "browsers", instance, kind.ToString().ToLowerInvariant());

    /// <summary>
    /// Delete every browser profile an instance had.
    /// </summary>
    /// <remarks>
    /// Best effort. A browser still open on one holds its files, and a profile
    /// that could not be deleted is disk space, not a session that failed to end.
    /// </remarks>
    public static void ForgetProfiles(string instance, Action<string> say)
    {
        var directory = Path.Combine(Host.HostConfig.Directory, "browsers", instance);

        if (!Directory.Exists(directory))
        {
            return;
        }

        try
        {
            Directory.Delete(directory, recursive: true);
            say($"browser profiles for {instance} removed");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            say($"browser profiles for {instance} left in {directory}: {e.Message}");
        }
    }
}
