using System.Globalization;
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
            ownsHandle: false), FileAccess.Write), new UTF8Encoding(false)) { AutoFlush = true };
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
[JsonSerializable(typeof(List<Commands.DiscoveredSession>))]
internal sealed partial class MachineJsonContext : JsonSerializerContext;
