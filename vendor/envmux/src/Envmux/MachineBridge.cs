using System.Globalization;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.Win32.SafeHandles;

namespace Envmux;

/// <summary>The private startup channel used by a supervising application.</summary>
/// <remarks>
/// The descriptor is inherited from the caller, never stdout. Credentials are
/// delivered there and omitted from the human log when this channel is active.
/// Losing the observer does not kill a session or interfere with Git recovery.
/// </remarks>
internal static class MachineBridge
{
    private static readonly StreamWriter? Writer = Open();
    private static readonly Lock Gate = new();

    public static bool Active => Writer is not null;

    /// <summary>Private startup descriptors, workspace authority and image selection belong to one process.</summary>
    /// <remarks>
    /// Self-spawned agents and editor endpoints retain the managed daemon, but
    /// Process.Start does not transfer the supervisor's descriptor or create a
    /// new writable ArtifactFS attempt. Never let their inherited environment
    /// claim either resource or the manager's per-launch toolchain belongs to the new child.
    /// </remarks>
    public static void PrepareChild(ProcessStartInfo info)
    {
        info.Environment.Remove("ENVMUX_BOOTSTRAP_FD");
        info.Environment.Remove("ENVMUX_WORKSPACE_BIND");
        info.Environment.Remove("ENVMUX_ARTIFACT_STATE_VOLUME");
        info.Environment.Remove("ENVMUX_MANAGED_GOLDEN_IMAGE");
    }

    private static StreamWriter? Open()
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("ENVMUX_BOOTSTRAP_FD"),
            CultureInfo.InvariantCulture, out var descriptor) || descriptor < 3)
        {
            return null;
        }

        // Enough currently ships this bridge on Mac/Linux. Windows needs an
        // explicitly inherited handle instead of pretending a POSIX fd exists.
        if (OperatingSystem.IsWindows())
        {
            throw new Config.ConfigException("ENVMUX_BOOTSTRAP_FD requires a POSIX descriptor");
        }

        return new StreamWriter(new FileStream(new SafeFileHandle((IntPtr)descriptor,
            ownsHandle: false), FileAccess.Write), new UTF8Encoding(false))
        { AutoFlush = true };
    }

    public static void Emit(MachineEvent message)
    {
        if (Writer is null)
        {
            return;
        }

        lock (Gate)
        {
            try
            {
                Writer.WriteLine(JsonSerializer.Serialize(message, MachineJsonContext.Default.MachineEvent));
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                // The lifecycle belongs to the session, not this observer.
            }
        }
    }

    public static void Observe(Session.Session session)
    {
        var last = "";
        session.Changed += () =>
        {
            lock (Gate)
            {
                if (session.Phase == last)
                {
                    return;
                }

                last = session.Phase;
                Emit(new MachineEvent("phase", Phase: last));
            }
        };
        Emit(new MachineEvent("phase", Phase: session.Phase));
    }
}

/// <summary>The small versioned bootstrap envelope; null fields are absent.</summary>
internal sealed record MachineEvent(
    string Type,
    int Version = 1,
    string? Phase = null,
    string? Endpoint = null,
    string? Token = null,
    string? Proxy = null,
    string? DockerHost = null,
    string? GoldenImage = null,
    string? Project = null,
    string? Session = null,
    string? Instance = null,
    string? Workdir = null,
    string? User = null,
    string? Branch = null,
    string? Head = null,
    int? CommitsAhead = null,
    int? DirtyFiles = null,
    string? Error = null,
    int? ExitCode = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(MachineEvent))]
[JsonSerializable(typeof(MachineCapabilities))]
[JsonSerializable(typeof(List<Commands.DiscoveredSession>))]
internal sealed partial class MachineJsonContext : JsonSerializerContext;

/// <summary>A supervisor checks the managed endpoint contract before creating anything.</summary>
internal sealed record MachineCapabilities(int ProtocolVersion, bool ManagedDocker, bool ManagedGoldenImage);
